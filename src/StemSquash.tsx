import React, { Component, createRef, memo } from 'react';
import { css } from './css';
import { renderTrackWav, analyzeSample, type Bar } from './audio';
import { makeZip, downloadBlob, type ZipEntry } from './zip';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ============================================================================
 * Stem Squash — Octatrack Stem Consolidator
 *
 * A dark, monochrome desktop tool for collapsing many DAW stems onto the
 * Octatrack's 7–8 tracks. Drag a sample card onto a track to link it; samples
 * linked to the same track collapse into one foldable group and a patterned
 * connector line is drawn. Export names files `<Project> - <Track name>.wav`.
 *
 * Ported from the Claude Design handoff; the export is fully wired up
 * (decode -> overlay-mix -> normalize -> WAV -> zip download).
 * ==========================================================================*/

const NBSP = ' ';

/* ---- monochrome palette (higher-contrast B/W) ---- */
const C = {
  bg: '#09090a',
  panel: '#101012',
  gutter: '#070708',
  card: '#171719',
  cardHi: '#212126',
  border: '#34343c',
  borderSoft: '#26262c',
  text: '#f5f5f7',
  text2: '#c2c2c9',
  text3: '#9a9aa2',
  muted: '#74747c',
  faint: '#4e4e56',
};

interface Sample {
  id: string;
  name: string;
  dur: number;
  bars: Bar[];
  url?: string;
}

interface Track {
  id: string;
  name: string;
}

type LinkMap = Record<string, string>;

interface PathSeg {
  id: string;
  d: string;
  stroke: string;
  width: number;
  dash: string;
  opacity: number;
}

type ExportPhase = 'config' | 'running' | 'done';
type Format = '16' | '24' | 'source';

interface Props {
  projectName?: string;
  trackSlots?: number;
}

interface State {
  projectName: string;
  samples: Sample[];
  tracks: Track[];
  links: LinkMap;
  collapsed: Record<string, boolean>;
  masterTrack: boolean;
  format: Format;
  playing: string | null;
  playPos: number;
  drag: { sampleId: string; x: number; y: number; moved: boolean } | null;
  overTrack: string | null;
  linkPaths: PathSeg[];
  exportOpen: boolean;
  exportPhase: ExportPhase;
  exportProgress: number;
  exportError: string | null;
}

/* ---------------------------------------------------------------------------
 * Small presentational helpers
 * ------------------------------------------------------------------------- */

function PlayGlyph({ playing }: { playing: boolean }) {
  return playing ? (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="1.5" y="1.5" width="7" height="7" rx="1" fill="currentColor" />
    </svg>
  ) : (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2.5 1.4 L8.6 5 L2.5 8.6 Z" fill="currentColor" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Sample row — memoized so playback / drag only repaints the affected row,
 * not every sample. Callbacks are stable class methods keyed by id.
 * ------------------------------------------------------------------------- */
interface RowProps {
  id: string;
  name: string;
  time: string;
  bars: Bar[];
  loading: boolean;
  linked: boolean;
  playing: boolean;
  playPos: number;
  isDragSrc: boolean;
  shade: string;
  onPlay: (id: string) => void;
  onScrub: (id: string, frac: number) => void;
  onDragStart: (id: string, e: React.MouseEvent) => void;
  onUnlink: (id: string) => void;
}

const SampleRow = memo(function SampleRow(p: RowProps) {
  const waveBase = p.linked ? '#5c5c64' : '#7a7a83';
  const wavePlayed = '#ffffff';
  const headX = +(p.playPos * 100).toFixed(2);

  const scrub = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    p.onScrub(p.id, frac);
  };

  return (
    <div
      className="ss-unfold"
      onMouseDown={(e) => p.onDragStart(p.id, e)}
      style={css(
        `display:flex;align-items:center;gap:12px;padding:9px 10px;border-radius:9px;margin-bottom:6px;cursor:grab;` +
          `background:${p.isDragSrc ? C.cardHi : C.card};border:1px solid ${p.isDragSrc ? '#ffffff' : C.border};` +
          `box-shadow:${p.isDragSrc ? '0 6px 18px rgba(0,0,0,0.5)' : 'none'};transition:background .1s,border-color .1s;`,
      )}
    >
      {/* play / stop */}
      <button
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          p.onPlay(p.id);
        }}
        title="Preview"
        style={css(
          `flex:0 0 auto;width:30px;height:30px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;` +
            `border:1px solid ${p.playing ? '#ffffff' : '#46464e'};background:${p.playing ? '#ffffff' : 'transparent'};color:${p.playing ? '#0a0a0b' : C.text2};`,
        )}
      >
        <PlayGlyph playing={p.playing} />
      </button>

      <div style={css('flex:1;min-width:0;')}>
        <div style={css('display:flex;align-items:baseline;gap:8px;')}>
          <span style={css(`font-size:13px;color:${C.text};font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`)}>{p.name}</span>
          <div style={css('flex:1;')}></div>
          <span style={css(`font-family:ui-monospace,monospace;font-size:10px;color:${C.muted};flex:0 0 auto;`)}>{p.time}</span>
        </div>

        {/* waveform + scrubber */}
        <div
          onMouseDown={(e) => {
            e.stopPropagation();
            scrub(e);
          }}
          onMouseMove={(e) => {
            // Only seek-on-drag once this sample is the one playing, so dragging
            // across an idle waveform doesn't restart playback on every move.
            if (p.playing && e.buttons === 1) scrub(e);
          }}
          title="Click or drag to scrub"
          style={css('margin-top:6px;height:30px;cursor:pointer;position:relative;')}
        >
          <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={p.loading ? 'ss-loading' : undefined} style={css('width:100%;height:30px;display:block;')}>
            <rect x={0} y={14.7} width={100} height={0.6} fill={waveBase} opacity={0.35} />
            {p.bars.map((b, bi) => (
              <rect key={bi} x={b.x} y={b.y} width={b.w} height={b.h} rx={0.4} fill={p.playing && b.x <= headX ? wavePlayed : waveBase} />
            ))}
            {p.loading && p.bars.length === 0 && (
              <rect x={0} y={13} width={100} height={4} rx={1} fill={waveBase} />
            )}
            {p.playing && <rect x={headX} y={0} width={0.8} height={30} fill="#ffffff" />}
          </svg>
        </div>
      </div>

      {/* connection handle / unlink */}
      <div style={css('display:flex;flex-direction:column;align-items:center;gap:7px;flex:0 0 auto;padding-left:2px;')}>
        <div
          data-dot={'s:' + p.id}
          title="Drag the card onto a track to link"
          style={css(
            `width:13px;height:13px;border-radius:50%;border:1.5px solid ${p.linked || p.isDragSrc ? '#ffffff' : '#6a6a72'};` +
              `background:${p.linked ? p.shade : p.isDragSrc ? '#ffffff' : 'transparent'};`,
          )}
        ></div>
        {p.linked && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              p.onUnlink(p.id);
            }}
            title="Unlink"
            style={css(`width:15px;height:15px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:${C.text3};font-size:13px;cursor:pointer;line-height:1;`)}
          >
            ×
          </div>
        )}
      </div>
    </div>
  );
});

export default class StemSquash extends Component<Props, State> {
  rootRef = createRef<HTMLDivElement>();
  fileRef = createRef<HTMLInputElement>();

  private _uid = 100;
  private readonly DASH = ['', '7 5', '1.5 5', '10 5 1.5 5', '4 4', '12 6 2 6', '2.5 4', '9 4 2.5 4'];
  // Higher-contrast greys for the per-track wayfinding system (kept strictly B/W).
  private readonly SHADE = ['#ffffff', '#c8c8d0', '#9c9ca5', '#e6e6ec', '#b4b4be', '#8c8c95', '#d6d6dd', '#a6a6b0'];

  private _onMove!: (e: MouseEvent) => void;
  private _onUp!: () => void;
  private _onResize!: () => void;
  private _mSched = false;
  private _mRaf = 0;
  private _playRaf = 0;
  private _exTimer: ReturnType<typeof setTimeout> | undefined;
  private _audio: HTMLAudioElement | null = null;
  private _pStart = 0;
  private _pDur = 0;
  private _layoutSig = '';
  private _psig = '';

  constructor(props: Props) {
    super(props);
    const slots = Math.max(4, Math.min(8, props.trackSlots || 8));
    const tracks: Track[] = [];
    for (let i = 0; i < slots; i++) tracks.push({ id: 't' + i, name: '' });
    this.state = {
      projectName: props.projectName || 'Untitled Project',
      samples: [],
      tracks,
      links: {},
      collapsed: {},
      masterTrack: false,
      format: '16',
      playing: null,
      playPos: 0,
      drag: null,
      overTrack: null,
      linkPaths: [],
      exportOpen: false,
      exportPhase: 'config',
      exportProgress: 0,
      exportError: null,
    };
  }

  /* ---------- helpers ---------- */
  fmt(sec: number) {
    const m = Math.floor(sec / 60),
      s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  masterIndex() {
    return this.state.masterTrack ? this.state.tracks.length - 1 : -1;
  }
  isMaster(i: number) {
    return i === this.masterIndex();
  }

  componentDidMount() {
    this._onMove = (e: MouseEvent) => {
      if (!this.state.drag) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const card = el && (el as Element).closest && (el as Element).closest('[data-track]');
      const ot = card ? card.getAttribute('data-track') : null;
      this.setState({ drag: { ...this.state.drag, x: e.clientX, y: e.clientY, moved: true }, overTrack: ot });
    };
    this._onUp = () => {
      if (!this.state.drag) return;
      const ot = this.state.overTrack,
        sid = this.state.drag.sampleId;
      this.setState((st) => {
        const links = { ...st.links };
        if (ot) links[sid] = ot;
        return { drag: null, overTrack: null, links };
      });
    };
    this._onResize = () => this.scheduleMeasure();
    window.addEventListener('mousemove', this._onMove);
    window.addEventListener('mouseup', this._onUp);
    window.addEventListener('resize', this._onResize);
    this.scheduleMeasure();
    setTimeout(() => this.scheduleMeasure(), 120);
    setTimeout(() => this.scheduleMeasure(), 420);
  }
  componentWillUnmount() {
    window.removeEventListener('mousemove', this._onMove);
    window.removeEventListener('mouseup', this._onUp);
    window.removeEventListener('resize', this._onResize);
    clearTimeout(this._exTimer);
    cancelAnimationFrame(this._playRaf);
    cancelAnimationFrame(this._mRaf);
    if (this._audio) this._audio.pause();
  }
  componentDidUpdate() {
    const sig = JSON.stringify({
      l: this.state.links,
      n: this.state.tracks.map((t) => t.name),
      o: this.state.samples.map((s) => s.id),
      c: this.state.collapsed,
      m: this.state.masterTrack,
      d: this.state.drag ? [Math.round(this.state.drag.x), Math.round(this.state.drag.y)] : 0,
    });
    if (sig !== this._layoutSig) {
      this._layoutSig = sig;
      this.scheduleMeasure();
    }
  }

  scheduleMeasure() {
    if (this._mSched) return;
    this._mSched = true;
    this._mRaf = requestAnimationFrame(() => {
      this._mSched = false;
      this.measure();
    });
  }
  trackIndex(id: string | null) {
    return this.state.tracks.findIndex((t) => t.id === id);
  }
  curve(a: { x: number; y: number }, b: { x: number; y: number }) {
    const mx = (a.x + b.x) / 2;
    return `M ${a.x} ${a.y} C ${mx} ${a.y} ${mx} ${b.y} ${b.x} ${b.y}`;
  }
  groupCollapsed(tid: string, len: number) {
    // Linked groups start expanded; folding is opt-in per group.
    return len > 1 && (this.state.collapsed[tid] ?? false);
  }
  measure() {
    const root = this.rootRef.current;
    if (!root) return;
    const svg = root.querySelector('[data-overlay]');
    if (!svg) return;
    const o = svg.getBoundingClientRect();
    const c: Record<string, { x: number; y: number }> = {};
    root.querySelectorAll('[data-dot]').forEach((el) => {
      const r = el.getBoundingClientRect();
      c[el.getAttribute('data-dot')!] = { x: r.left + r.width / 2 - o.left, y: r.top + r.height / 2 - o.top };
    });
    const paths: PathSeg[] = [];
    const masterIdx = this.masterIndex();
    // group samples per track so collapsed groups draw a single connector
    const perTrack: Record<string, string[]> = {};
    for (const sid in this.state.links) {
      const tid = this.state.links[sid];
      const ti = this.trackIndex(tid);
      if (ti < 0 || ti === masterIdx) continue;
      (perTrack[tid] = perTrack[tid] || []).push(sid);
    }
    for (const tid in perTrack) {
      const sids = perTrack[tid];
      const i = this.trackIndex(tid);
      const b = c['t:' + tid];
      if (!b) continue;
      const seg = (a: { x: number; y: number } | undefined, key: string) => {
        if (!a) return;
        paths.push({ id: key, d: this.curve(a, b), stroke: this.SHADE[i % 8], width: 1.5, dash: this.DASH[i % 8], opacity: 0.95 });
      };
      if (this.groupCollapsed(tid, sids.length)) {
        seg(c['g:' + tid], 'g:' + tid);
      } else {
        sids.forEach((sid) => seg(c['s:' + sid], sid));
      }
    }
    if (this.state.drag && this.state.drag.moved) {
      const a = c['s:' + this.state.drag.sampleId];
      if (a) {
        const cur = { x: this.state.drag.x - o.left, y: this.state.drag.y - o.top };
        paths.push({ id: '__drag', d: this.curve(a, cur), stroke: '#ffffff', width: 1.6, dash: '4 4', opacity: 0.95 });
      }
    }
    const psig = JSON.stringify(paths);
    if (psig !== this._psig) {
      this._psig = psig;
      this.setState({ linkPaths: paths });
    }
  }

  /* ---------- interactions (stable arrow methods for memoized rows) ---------- */
  startDrag = (sid: string, e: React.MouseEvent) => {
    e.preventDefault();
    this.setState({ drag: { sampleId: sid, x: e.clientX, y: e.clientY, moved: false }, overTrack: null });
  };
  unlink = (sid: string) => {
    this.setState((st) => {
      const links = { ...st.links };
      delete links[sid];
      return { links };
    });
  };
  toggleCollapse = (tid: string) => {
    this.setState((st) => ({ collapsed: { ...st.collapsed, [tid]: !(st.collapsed[tid] ?? false) } }));
  };
  setTrackName(id: string, v: string) {
    this.setState((st) => ({ tracks: st.tracks.map((t) => (t.id === id ? { ...t, name: v } : t)) }));
  }
  toggleMaster = () => {
    this.setState((st) => ({ masterTrack: !st.masterTrack }));
  };

  play = (id: string, startFrac = 0) => {
    const cur = this.state.playing;
    this.stopAudio();
    if (cur === id && !startFrac) {
      this.setState({ playing: null, playPos: 0 });
      return;
    }
    const s = this.state.samples.find((x) => x.id === id);
    if (!s) return;
    this._pDur = Math.max(400, s.dur * 1000);
    if (s.url) {
      try {
        const audio = new Audio(s.url);
        this._audio = audio;
        const begin = () => {
          if (startFrac > 0) audio.currentTime = startFrac * (audio.duration || s.dur || 1);
          audio.play().catch(() => {});
        };
        if (audio.readyState >= 1) begin();
        else audio.onloadedmetadata = begin;
        audio.onended = () => this.setState({ playing: null, playPos: 0 });
      } catch {
        /* ignore */
      }
    }
    this._pStart = performance.now() - startFrac * this._pDur;
    this.setState({ playing: id, playPos: startFrac });
    this._tick();
  };
  scrub = (id: string, frac: number) => {
    if (this.state.playing === id && this._audio) {
      this._audio.currentTime = frac * (this._audio.duration || this._pDur / 1000 || 1);
      this._pStart = performance.now() - frac * this._pDur;
      this.setState({ playPos: frac });
    } else {
      this.play(id, Math.max(0.0001, frac));
    }
  };
  _tick = () => {
    if (this.state.playing == null) return;
    let t: number;
    if (this._audio && this._audio.duration) t = this._audio.currentTime / this._audio.duration;
    else t = (performance.now() - this._pStart) / this._pDur;
    if (t >= 1) {
      this.stopAudio();
      this.setState({ playing: null, playPos: 0 });
      return;
    }
    this.setState({ playPos: t });
    this._playRaf = requestAnimationFrame(this._tick);
  };
  stopAudio() {
    cancelAnimationFrame(this._playRaf);
    if (this._audio) {
      try {
        this._audio.pause();
      } catch {
        /* ignore */
      }
      this._audio = null;
    }
  }

  onAdd(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const add: Sample[] = files.map((f) => ({
      id: 's' + ++this._uid,
      name: f.name,
      dur: 0,
      bars: [],
      url: URL.createObjectURL(f),
    }));
    this.setState((st) => ({ samples: [...st.samples, ...add] }));
    e.target.value = '';
    // Decode each file once (cached + reused by export) to get its real
    // duration and a real peak waveform.
    add.forEach((sm) => {
      analyzeSample(sm)
        .then(({ dur, bars }) =>
          this.setState((st) => ({ samples: st.samples.map((x) => (x.id === sm.id ? { ...x, dur, bars } : x)) })),
        )
        .catch((err) => console.error('could not analyze', sm.name, err));
    });
  }

  outputs() {
    const out: { id: string; idx: number; name: string; srcCount: number }[] = [];
    const masterIdx = this.masterIndex();
    this.state.tracks.forEach((t, i) => {
      if (i === masterIdx) return;
      const src = this.state.samples.filter((s) => this.state.links[s.id] === t.id);
      if (src.length) out.push({ id: t.id, idx: i, name: t.name || 'Track ' + (i + 1), srcCount: src.length });
    });
    return out;
  }
  openExport() {
    if (this.outputs().length === 0) return;
    this.setState({ exportOpen: true, exportPhase: 'config', exportError: null });
  }
  closeExport() {
    clearTimeout(this._exTimer);
    this.setState({ exportOpen: false });
  }
  async runExport() {
    const outs = this.outputs();
    if (!outs.length) return;
    this.setState({ exportPhase: 'running', exportProgress: 0, exportError: null });
    try {
      const entries: ZipEntry[] = [];
      for (let k = 0; k < outs.length; k++) {
        if (!this.state.exportOpen) return; // modal closed → abort
        const o = outs[k];
        const samples = this.state.samples.filter((s) => this.state.links[s.id] === o.id);
        const wav = await renderTrackWav(samples, this.state.format);
        const fname = `${this.state.projectName} - ${o.name}.wav`;
        entries.push({ name: `${this.state.projectName}/${fname}`, data: wav });
        this.setState({ exportProgress: k + 1 });
        await sleep(120); // let each tick land visibly
      }
      if (!this.state.exportOpen) return;
      downloadBlob(makeZip(entries), `${this.state.projectName || 'stems'}.zip`);
      this.setState({ exportPhase: 'done' });
    } catch (err) {
      console.error('export failed', err);
      this.setState({ exportPhase: 'done', exportError: err instanceof Error ? err.message : String(err) });
    }
  }

  dashBorder(i: number): string {
    const d = this.DASH[i % 8];
    return d === '' ? 'solid' : d.startsWith('1.5') || d.startsWith('2.5') ? 'dotted' : 'dashed';
  }

  /* ---------- view ---------- */
  render() {
    const st = this.state;
    const drag = st.drag;
    const masterIdx = this.masterIndex();
    const presets = ['Drums', 'Percs', 'Hats', 'Cymbals', 'Bass', 'Sub', 'Lead', 'Pad', 'Keys', 'Vocals', 'FX'];

    // ----- left list ordered & grouped -----
    const byTrack: Record<string, Sample[]> = {};
    const unassigned: Sample[] = [];
    st.samples.forEach((s) => {
      const t = st.links[s.id];
      const ti = this.trackIndex(t);
      if (t && ti >= 0 && ti !== masterIdx) (byTrack[t] = byTrack[t] || []).push(s);
      else unassigned.push(s);
    });

    interface Group {
      label: string;
      name: string;
      color: string;
      tid: string | null;
      idx: number;
      list: Sample[];
    }
    const groups: Group[] = [];
    st.tracks.forEach((t, i) => {
      if (i === masterIdx) return;
      const list = byTrack[t.id];
      if (list && list.length)
        groups.push({ label: 'T' + (i + 1), name: (t.name || 'Untitled').toUpperCase(), color: this.SHADE[i % 8], tid: t.id, idx: i, list });
    });
    if (unassigned.length) groups.push({ label: 'UNASSIGNED', name: '', color: C.muted, tid: null, idx: -1, list: unassigned });

    // ----- tracks (right) -----
    const tracksView = st.tracks.map((t, i) => {
      const assigned = st.samples.filter((s) => st.links[s.id] === t.id);
      const has = assigned.length > 0;
      const hi = !!drag && st.overTrack === t.id;
      const shade = this.SHADE[i % 8];
      const borderStyle = this.dashBorder(i);
      return {
        id: t.id,
        index: i,
        master: i === masterIdx,
        label: 'T' + (i + 1),
        name: t.name,
        idxColor: has ? shade : C.text3,
        onName: (e: React.ChangeEvent<HTMLInputElement>) => this.setTrackName(t.id, e.target.value),
        onPreset: (e: React.ChangeEvent<HTMLSelectElement>) => {
          const v = e.target.value;
          if (v) this.setTrackName(t.id, v);
        },
        assigned: assigned.map((s) => ({ id: s.id, name: s.name, onRemove: () => this.unlink(s.id) })),
        hasSamples: has,
        countLabel: has ? assigned.length + ' → 1' : '—',
        shade,
        borderStyle,
        hi,
      };
    });

    // ----- export -----
    const outs = this.outputs();
    const fmtMeta: Record<Format, string> = { '16': '16-bit', '24': '24-bit', source: 'source' };
    const outputsView = outs.map((o, k) => {
      const done = st.exportProgress > k;
      const cur = st.exportProgress === k;
      return {
        file: `${st.projectName} - ${o.name}.wav`,
        srcLabel: `${o.srcCount} src · ${fmtMeta[st.format]}`,
        swatch: `flex:0 0 auto;width:24px;height:0;border-top:1.5px ${this.dashBorder(o.idx)} ${this.SHADE[o.idx % 8]};`,
        tick: done ? '✓' : '·',
        tickColor: done ? '#ffffff' : cur ? C.text3 : C.faint,
      };
    });
    const fOpt = (key: Format, label: string) => {
      const a = st.format === key;
      return {
        label,
        onSelect: () => this.setState({ format: key }),
        style: `background:${a ? '#ffffff' : 'transparent'};color:${a ? '#0a0a0b' : C.text3};border:none;border-radius:6px;font-size:11.5px;font-weight:${a ? '600' : '400'};padding:6px 13px;cursor:pointer;`,
      };
    };
    const formatOptions = [fOpt('16', '16-bit'), fOpt('24', '24-bit'), fOpt('source', 'Source')];

    const linked = Object.keys(st.links).filter((k) => {
      const ti = this.trackIndex(st.links[k]);
      return ti >= 0 && ti !== masterIdx;
    }).length;
    const trackCount = st.tracks.length - (st.masterTrack ? 1 : 0);
    const used = outs.length;
    const exportOK = used > 0;

    const uiSelect = drag ? 'none' : 'auto';
    const summary = `${linked}/${st.samples.length} linked  ·  ${used}/${trackCount} tracks`;
    const exportBtnLabel = exportOK ? `Export → ${used} stems` : 'Export';
    const exportBtnStyle = `white-space:nowrap;background:${exportOK ? '#ffffff' : '#1c1c1f'};color:${exportOK ? '#0a0a0b' : C.muted};border:1px solid ${exportOK ? '#ffffff' : C.borderSoft};border-radius:7px;font-size:12.5px;font-weight:600;padding:9px 16px;cursor:${exportOK ? 'pointer' : 'not-allowed'};`;
    const runBtnStyle = `background:#ffffff;border:none;border-radius:7px;color:#0a0a0b;font-size:12.5px;font-weight:600;padding:9px 18px;cursor:pointer;`;

    return (
      <div
        ref={this.rootRef}
        style={css(
          `height:100vh;display:flex;flex-direction:column;background:${C.bg};color:${C.text};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;user-select:${uiSelect};overflow:hidden;`,
        )}
      >
        {/* ============ HEADER ============ */}
        <header style={css(`flex:0 0 auto;height:60px;display:flex;align-items:center;gap:22px;padding:0 22px;border-bottom:1px solid ${C.borderSoft};background:${C.panel};`)}>
          <div style={css('display:flex;align-items:center;gap:11px;')}>
            <div style={css('width:26px;height:26px;border:1.5px solid #8a8a92;border-radius:5px;display:flex;align-items:center;justify-content:center;')}>
              <div style={css('width:11px;height:11px;border-radius:50%;background:#ffffff;')}></div>
            </div>
            <div style={css("font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px;letter-spacing:2.5px;color:#ffffff;")}>STEM{NBSP}SQUASH</div>
          </div>

          <div style={css(`width:1px;height:26px;background:${C.borderSoft};`)}></div>

          <label style={css('display:flex;align-items:center;gap:10px;')}>
            <span style={css(`font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:9.5px;letter-spacing:1.5px;color:${C.muted};`)}>PROJECT</span>
            <input
              value={st.projectName}
              onChange={(e) => this.setState({ projectName: e.target.value })}
              placeholder="Untitled Project"
              spellCheck={false}
              style={css(`background:${C.bg};border:1px solid ${C.border};border-radius:6px;color:${C.text};font-size:13.5px;font-weight:500;padding:7px 11px;width:230px;outline:none;`)}
            />
          </label>

          <div style={css('flex:1 1 auto;')}></div>

          {/* T8 master toggle */}
          <button
            onClick={this.toggleMaster}
            title="Use track 8 as the master bus — it is hidden and not exported as a stem"
            style={css(
              `display:flex;align-items:center;gap:8px;background:${st.masterTrack ? '#ffffff' : 'transparent'};border:1px solid ${st.masterTrack ? '#ffffff' : C.border};` +
                `border-radius:7px;padding:7px 11px;cursor:pointer;color:${st.masterTrack ? '#0a0a0b' : C.text3};font-size:11px;letter-spacing:0.3px;`,
            )}
          >
            <span
              style={css(
                `width:24px;height:13px;border-radius:7px;position:relative;flex:0 0 auto;background:${st.masterTrack ? '#0a0a0b' : '#2c2c32'};transition:background .12s;`,
              )}
            >
              <span
                style={css(
                  `position:absolute;top:2px;left:${st.masterTrack ? '13px' : '2px'};width:9px;height:9px;border-radius:50%;background:#ffffff;transition:left .12s;`,
                )}
              ></span>
            </span>
            T8 master
          </button>

          <div style={css(`font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11px;letter-spacing:0.5px;color:${C.text3};`)}>{summary}</div>

          <button onClick={() => this.openExport()} style={css(exportBtnStyle)}>
            {exportBtnLabel}
          </button>
        </header>

        {/* ============ BODY ============ */}
        <div style={css('flex:1 1 auto;position:relative;display:flex;min-height:0;')}>
          {/* connector overlay */}
          <svg data-overlay="1" style={css('position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6;overflow:visible;')}>
            {st.linkPaths.map((p) => (
              <path key={p.id} d={p.d} fill="none" stroke={p.stroke} strokeWidth={p.width} strokeDasharray={p.dash} strokeLinecap="round" opacity={p.opacity}></path>
            ))}
          </svg>

          {/* ===== LEFT : SAMPLES ===== */}
          <section onScroll={() => this.scheduleMeasure()} className="ss-scroll" style={css(`flex:1 1 auto;min-width:400px;overflow-y:auto;background:${C.panel};border-right:1px solid ${C.borderSoft};`)}>
            <div style={css(`position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:13px 20px 12px 20px;background:${C.panel};border-bottom:1px solid ${C.borderSoft};`)}>
              <span style={css(`font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:10px;letter-spacing:2px;color:${C.text3};`)}>SAMPLES</span>
              <span style={css(`font-family:ui-monospace,monospace;font-size:10px;color:${C.muted};`)}>{String(st.samples.length)}</span>
              <div style={css('flex:1;')}></div>
              <button onClick={() => this.fileRef.current && this.fileRef.current.click()} style={css(`display:flex;align-items:center;gap:6px;background:transparent;border:1px solid ${C.border};border-radius:6px;color:${C.text2};font-size:11.5px;padding:6px 11px;cursor:pointer;`)}>
                + Add files
              </button>
              <input ref={this.fileRef} onChange={(e) => this.onAdd(e)} type="file" accept="audio/*" multiple style={css('display:none;')} />
            </div>

            <div style={css('padding:10px 14px 40px 14px;')}>
              {groups.map((g) => {
                const collapsible = g.tid != null && g.list.length > 1;
                const collapsed = g.tid != null && this.groupCollapsed(g.tid, g.list.length);
                return (
                  <div key={g.tid || 'unassigned'} style={css('margin-bottom:14px;')}>
                    {/* group header */}
                    <div
                      onClick={collapsible ? () => this.toggleCollapse(g.tid!) : undefined}
                      style={css(`display:flex;align-items:center;gap:9px;padding:4px 6px 9px 6px;${collapsible ? 'cursor:pointer;' : ''}`)}
                    >
                      {collapsible && (
                        <span style={css(`color:${C.text3};font-size:9px;width:10px;display:inline-block;transition:transform .12s;transform:rotate(${collapsed ? 0 : 90}deg);`)}>▶</span>
                      )}
                      <span style={css(`font-family:ui-monospace,monospace;font-size:9.5px;letter-spacing:1.6px;color:${g.color};`)}>{g.label}</span>
                      {g.name && <span style={css(`font-family:ui-monospace,monospace;font-size:9.5px;letter-spacing:1.4px;color:${C.text3};`)}>{g.name}</span>}
                      <div style={css(`flex:1;height:1px;background:${C.borderSoft};`)}></div>
                      <span style={css(`font-family:ui-monospace,monospace;font-size:9.5px;color:${C.muted};`)}>{String(g.list.length)}</span>
                    </div>

                    {collapsed ? (
                      /* collapsed stack — one card representing the whole group */
                      <div
                        onClick={() => this.toggleCollapse(g.tid!)}
                        style={css(`position:relative;cursor:pointer;`)}
                      >
                        {/* stacked shadows behind */}
                        <div style={css(`position:absolute;left:6px;right:6px;top:8px;height:46px;border-radius:9px;background:${C.card};border:1px solid ${C.borderSoft};opacity:0.5;`)}></div>
                        <div style={css(`position:absolute;left:3px;right:3px;top:4px;height:46px;border-radius:9px;background:${C.card};border:1px solid ${C.border};opacity:0.75;`)}></div>
                        <div style={css(`position:relative;display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:9px;background:${C.card};border:1px solid ${C.border};`)}>
                          <div style={css(`flex:0 0 auto;width:30px;height:30px;border-radius:8px;border:1px solid ${C.border};display:flex;align-items:center;justify-content:center;font-family:ui-monospace,monospace;font-size:12px;color:${g.color};`)}>
                            {g.list.length}
                          </div>
                          <div style={css('flex:1;min-width:0;')}>
                            <div style={css(`font-size:13px;color:${C.text};font-weight:500;`)}>{g.list.length} samples squashed</div>
                            <div style={css(`font-size:11px;color:${C.text3};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;`)}>
                              {g.list.map((s) => s.name).join(' · ')}
                            </div>
                          </div>
                          <span style={css(`font-size:10.5px;color:${C.text3};flex:0 0 auto;`)}>unfold</span>
                          <div data-dot={'g:' + g.tid} style={css(`width:13px;height:13px;border-radius:50%;border:1.5px solid #ffffff;background:${g.color};flex:0 0 auto;`)}></div>
                        </div>
                      </div>
                    ) : (
                      g.list.map((s) => (
                        <SampleRow
                          key={s.id}
                          id={s.id}
                          name={s.name}
                          time={this.fmt(s.dur)}
                          bars={s.bars}
                          loading={s.bars.length === 0}
                          linked={g.tid != null}
                          playing={st.playing === s.id}
                          playPos={st.playing === s.id ? st.playPos : 0}
                          isDragSrc={!!drag && drag.sampleId === s.id}
                          shade={g.color}
                          onPlay={this.play}
                          onScrub={this.scrub}
                          onDragStart={this.startDrag}
                          onUnlink={this.unlink}
                        />
                      ))
                    )}
                  </div>
                );
              })}

              {st.samples.length === 0 && (
                <div style={css(`text-align:center;color:${C.text3};font-size:12.5px;padding:60px 20px;line-height:1.7;`)}>
                  No samples loaded.
                  <br />
                  Add your exported stems to begin.
                </div>
              )}
            </div>
          </section>

          {/* gutter */}
          <div style={css(`flex:0 0 132px;background:${C.gutter};`)}></div>

          {/* ===== RIGHT : TRACKS ===== */}
          <section onScroll={() => this.scheduleMeasure()} className="ss-scroll" style={css(`flex:0 0 452px;overflow-y:auto;background:${C.panel};border-left:1px solid ${C.borderSoft};`)}>
            <div style={css(`position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:13px 20px 12px 22px;background:${C.panel};border-bottom:1px solid ${C.borderSoft};`)}>
              <span style={css(`font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:10px;letter-spacing:2px;color:${C.text3};`)}>
                OCTATRACK{NBSP}·{NBSP}TRACKS
              </span>
              <div style={css('flex:1;')}></div>
              <span style={css(`font-family:ui-monospace,monospace;font-size:10px;color:${C.muted};`)}>{String(used)} active</span>
            </div>

            <div style={css('padding:12px 18px 40px 18px;display:flex;flex-direction:column;gap:11px;')}>
              {tracksView.map((t) =>
                t.master ? (
                  /* master bus — disabled, not a drop target, not exported */
                  <div key={t.id} style={css(`position:relative;background:${C.bg};border:1px dashed ${C.border};border-radius:10px;padding:13px 16px;display:flex;align-items:center;gap:11px;opacity:0.92;`)}>
                    <span style={css(`font-family:ui-monospace,monospace;font-size:11px;letter-spacing:1px;color:${C.text3};font-weight:600;`)}>{t.label}</span>
                    <span style={css(`font-family:ui-monospace,monospace;font-size:10px;letter-spacing:2px;color:${C.text2};border:1px solid ${C.border};border-radius:4px;padding:2px 7px;`)}>MASTER</span>
                    <span style={css(`font-size:11.5px;color:${C.muted};`)}>main output bus · not exported</span>
                  </div>
                ) : (
                  <div
                    key={t.id}
                    data-track={t.id}
                    style={css(
                      `position:relative;background:${t.hi ? C.cardHi : C.card};border:1px solid ${t.hi ? '#ffffff' : t.hasSamples ? C.border : C.borderSoft};border-radius:10px;padding:14px 16px;transition:border-color .1s,background .1s;`,
                    )}
                  >
                    {/* target dot (anchored to left edge, into gutter) */}
                    <div
                      data-dot={'t:' + t.id}
                      style={css(`position:absolute;left:-7px;top:18px;width:13px;height:13px;border-radius:50%;border:1.5px solid ${t.hasSamples ? '#ffffff' : '#6a6a72'};background:${t.hasSamples ? t.shade : C.bg};`)}
                    ></div>

                    <div style={css('display:flex;align-items:center;gap:11px;')}>
                      <div style={css('display:flex;align-items:center;gap:8px;flex:0 0 auto;')}>
                        <span style={css(`font-family:ui-monospace,monospace;font-size:11px;letter-spacing:1px;color:${t.idxColor};font-weight:600;`)}>{t.label}</span>
                        <div
                          style={css(
                            `width:7px;height:7px;border-radius:50%;background:${t.hasSamples ? '#ffffff' : 'transparent'};border:1px solid ${t.hasSamples ? '#ffffff' : C.border};box-shadow:${t.hasSamples ? '0 0 7px rgba(255,255,255,0.6)' : 'none'};`,
                          )}
                        ></div>
                      </div>

                      {/* integrated name + preset control */}
                      <div style={css(`display:flex;align-items:stretch;flex:1;min-width:0;border:1px solid ${C.border};border-radius:8px;background:${C.bg};overflow:hidden;`)}>
                        <input
                          value={t.name}
                          onChange={t.onName}
                          placeholder="name this track"
                          spellCheck={false}
                          style={css(`flex:1;min-width:0;background:transparent;border:none;color:${C.text};font-size:14px;font-weight:500;padding:8px 11px;outline:none;`)}
                        />
                        <div style={css(`width:1px;background:${C.border};`)}></div>
                        <select value="" onChange={t.onPreset} title="Pick a preset name" style={css(`flex:0 0 auto;background:transparent;border:none;color:${C.text3};font-size:11px;padding:0 9px;outline:none;cursor:pointer;`)}>
                          <option value="" disabled>
                            preset ▾
                          </option>
                          {presets.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* line-identity + assigned */}
                    <div style={css('display:flex;align-items:center;gap:10px;margin-top:11px;')}>
                      <div style={css(`flex:0 0 40px;height:0;border-top:1.5px ${t.borderStyle} ${t.hasSamples ? t.shade : C.borderSoft};`)}></div>
                      {t.hasSamples ? (
                        <div style={css('display:flex;flex-wrap:wrap;gap:6px;flex:1;')}>
                          {t.assigned.map((a) => (
                            <div key={a.id} style={css(`display:flex;align-items:center;gap:6px;background:${C.bg};border:1px solid ${C.border};border-radius:5px;padding:4px 6px 4px 9px;`)}>
                              <span style={css(`font-size:11px;color:${C.text2};max-width:130px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`)}>{a.name}</span>
                              <div onClick={a.onRemove} title="Remove" style={css(`color:${C.text3};font-size:12px;cursor:pointer;line-height:1;`)}>
                                ×
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span style={css(`flex:1;font-size:11.5px;color:${C.muted};font-style:italic;`)}>drag samples here to squash into one stem</span>
                      )}
                      <span style={css(`flex:0 0 auto;font-family:ui-monospace,monospace;font-size:10px;color:${C.muted};`)}>{t.countLabel}</span>
                    </div>
                  </div>
                ),
              )}
            </div>
          </section>
        </div>

        {/* ============ EXPORT MODAL ============ */}
        {st.exportOpen && (
          <div onClick={() => this.closeExport()} style={css('position:fixed;inset:0;z-index:40;background:rgba(3,3,5,0.8);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);')}>
            <div onClick={(e) => e.stopPropagation()} style={css(`width:540px;max-height:84vh;display:flex;flex-direction:column;background:${C.panel};border:1px solid ${C.border};border-radius:12px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,0.6);`)}>
              <div style={css(`display:flex;align-items:center;gap:12px;padding:18px 22px;border-bottom:1px solid ${C.borderSoft};`)}>
                <span style={css('font-family:ui-monospace,monospace;font-size:11px;letter-spacing:2px;color:#ffffff;')}>EXPORT{NBSP}STEMS</span>
                <div style={css('flex:1;')}></div>
                <div onClick={() => this.closeExport()} style={css(`color:${C.text3};font-size:18px;cursor:pointer;line-height:1;`)}>
                  ×
                </div>
              </div>

              {/* CONFIG */}
              {st.exportPhase === 'config' && (
                <>
                  <div style={css('padding:18px 22px;overflow-y:auto;')} className="ss-scroll">
                    <div style={css('display:flex;align-items:center;gap:14px;margin-bottom:18px;')}>
                      <span style={css(`font-family:ui-monospace,monospace;font-size:10px;letter-spacing:1px;color:${C.text3};width:64px;`)}>FORMAT</span>
                      <div style={css(`display:flex;gap:4px;background:${C.bg};border:1px solid ${C.border};border-radius:8px;padding:3px;`)}>
                        {formatOptions.map((f) => (
                          <button key={f.label} onClick={f.onSelect} style={css(f.style)}>
                            {f.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={css('display:flex;align-items:center;gap:14px;margin-bottom:6px;')}>
                      <span style={css(`font-family:ui-monospace,monospace;font-size:10px;letter-spacing:1px;color:${C.text3};width:64px;`)}>PROCESS</span>
                      <span style={css(`font-size:12px;color:${C.text2};`)}>
                        Overlay-mix{NBSP}·{NBSP}normalize to −0.3{NBSP}dB
                      </span>
                    </div>

                    <div style={css(`margin-top:18px;border-top:1px solid ${C.borderSoft};padding-top:14px;`)}>
                      <div style={css(`font-family:ui-monospace,monospace;font-size:10px;letter-spacing:1px;color:${C.text3};margin-bottom:10px;`)}>
                        OUTPUT{NBSP}·{NBSP}{String(outs.length)} FILES → ./{st.projectName}/
                      </div>
                      {outputsView.map((o, k) => (
                        <div key={k} style={css(`display:flex;align-items:center;gap:10px;padding:9px 11px;background:${C.bg};border:1px solid ${C.border};border-radius:7px;margin-bottom:7px;`)}>
                          <div style={css(o.swatch)}></div>
                          <span style={css(`font-family:ui-monospace,monospace;font-size:12px;color:${C.text};flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`)}>{o.file}</span>
                          <span style={css(`font-family:ui-monospace,monospace;font-size:10px;color:${C.muted};`)}>{o.srcLabel}</span>
                        </div>
                      ))}
                      {outs.length === 0 && <div style={css(`color:${C.text3};font-size:12.5px;padding:20px;text-align:center;`)}>No tracks have samples assigned yet.</div>}
                    </div>
                  </div>
                  <div style={css(`display:flex;gap:10px;padding:16px 22px;border-top:1px solid ${C.borderSoft};`)}>
                    <div style={css('flex:1;')}></div>
                    <button onClick={() => this.closeExport()} style={css(`background:transparent;border:1px solid ${C.border};border-radius:7px;color:${C.text2};font-size:12.5px;padding:9px 16px;cursor:pointer;`)}>
                      Cancel
                    </button>
                    <button onClick={() => this.runExport()} style={css(runBtnStyle)}>
                      Export {String(outs.length)} stems
                    </button>
                  </div>
                </>
              )}

              {/* RUNNING */}
              {st.exportPhase === 'running' && (
                <div style={css('padding:26px 22px;')}>
                  {outputsView.map((o, k) => (
                    <div key={k} style={css('display:flex;align-items:center;gap:11px;padding:9px 4px;')}>
                      <span style={css(`font-family:ui-monospace,monospace;font-size:13px;width:16px;color:${o.tickColor};`)}>{o.tick}</span>
                      <span style={css(`font-family:ui-monospace,monospace;font-size:12px;color:${o.tickColor};flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`)}>{o.file}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* DONE */}
              {st.exportPhase === 'done' && (
                <div style={css('padding:34px 22px;text-align:center;')}>
                  <div style={css('width:48px;height:48px;border:1.5px solid #ffffff;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px auto;font-size:22px;color:#ffffff;')}>✓</div>
                  <div style={css(`font-size:15px;color:${C.text};font-weight:500;margin-bottom:6px;`)}>Squashed {String(outs.length)} stems</div>
                  <div style={css(`font-family:ui-monospace,monospace;font-size:11px;color:${C.text3};line-height:1.7;`)}>
                    written to ./{st.projectName}/
                    <br />
                    ready for Octatrack import
                  </div>
                  {st.exportError ? (
                    <div style={css('margin-top:14px;font-size:10.5px;color:#d79a9a;font-style:italic;')}>export error · {st.exportError}</div>
                  ) : (
                    <div style={css(`margin-top:14px;font-size:10.5px;color:${C.muted};font-style:italic;`)}>{(st.projectName || 'stems') + '.zip'} downloaded · overlay-mixed & normalized</div>
                  )}
                  <button onClick={() => this.closeExport()} style={css('margin-top:22px;background:#ffffff;border:none;border-radius:7px;color:#0a0a0b;font-size:12.5px;font-weight:600;padding:10px 24px;cursor:pointer;')}>
                    Done
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
}
