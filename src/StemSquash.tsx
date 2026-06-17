import React, { Component, createRef } from 'react';
import { css } from './css';
import { renderTrackWav, analyzeSample, type Bar } from './audio';
import { makeZip, downloadBlob, type ZipEntry } from './zip';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ============================================================================
 * Stem Squash — Octatrack Stem Consolidator
 *
 * A dark, monochrome desktop tool for collapsing many DAW stems onto the
 * Octatrack's 7–8 tracks. Drag a sample's connector dot onto a track to link
 * it; linked samples sort into their track's group and a patterned connector
 * line is drawn. Export names files `<Project> - <Track name>.wav`.
 *
 * Ported from the Claude Design handoff (`Stem Squash.dc.html`); the export is
 * fully wired up (decode -> overlay-mix -> normalize -> WAV -> zip download).
 * ==========================================================================*/

const NBSP = ' ';

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
  format: Format;
  playing: string | null;
  playPos: number;
  drag: { sampleId: string; x: number; y: number } | null;
  overTrack: string | null;
  linkPaths: PathSeg[];
  exportOpen: boolean;
  exportPhase: ExportPhase;
  exportProgress: number;
  exportError: string | null;
}

export default class StemSquash extends Component<Props, State> {
  rootRef = createRef<HTMLDivElement>();
  fileRef = createRef<HTMLInputElement>();

  private _uid = 100;
  private readonly DASH = ['', '7 5', '1.5 5', '10 5 1.5 5', '4 4', '12 6 2 6', '2.5 4', '9 4 2.5 4'];
  private readonly SHADE = ['#f3f3f5', '#c4c4ca', '#9a9aa1', '#dcdce0', '#b0b0b7', '#86868d', '#e6e6ea', '#a8a8ae'];

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

  componentDidMount() {
    this._onMove = (e: MouseEvent) => {
      if (!this.state.drag) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const card = el && (el as Element).closest && (el as Element).closest('[data-track]');
      const ot = card ? card.getAttribute('data-track') : null;
      this.setState({ drag: { ...this.state.drag, x: e.clientX, y: e.clientY }, overTrack: ot });
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
    for (const sid in this.state.links) {
      const tid = this.state.links[sid];
      const a = c['s:' + sid],
        b = c['t:' + tid];
      if (!a || !b) continue;
      const i = this.trackIndex(tid);
      paths.push({ id: sid, d: this.curve(a, b), stroke: this.SHADE[i % 8], width: 1.4, dash: this.DASH[i % 8], opacity: 0.92 });
    }
    if (this.state.drag) {
      const a = c['s:' + this.state.drag.sampleId];
      if (a) {
        const cur = { x: this.state.drag.x - o.left, y: this.state.drag.y - o.top };
        paths.push({ id: '__drag', d: this.curve(a, cur), stroke: '#ffffff', width: 1.4, dash: '4 4', opacity: 0.9 });
      }
    }
    const psig = JSON.stringify(paths);
    if (psig !== this._psig) {
      this._psig = psig;
      this.setState({ linkPaths: paths });
    }
  }

  /* ---------- interactions ---------- */
  startDrag(sid: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.setState({ drag: { sampleId: sid, x: e.clientX, y: e.clientY }, overTrack: null });
  }
  unlink(sid: string) {
    this.setState((st) => {
      const links = { ...st.links };
      delete links[sid];
      return { links };
    });
  }
  setTrackName(id: string, v: string) {
    this.setState((st) => ({ tracks: st.tracks.map((t) => (t.id === id ? { ...t, name: v } : t)) }));
  }

  play(id: string) {
    const cur = this.state.playing;
    this.stopAudio();
    if (cur === id) {
      this.setState({ playing: null, playPos: 0 });
      return;
    }
    const s = this.state.samples.find((x) => x.id === id);
    if (!s) return;
    if (s.url) {
      try {
        this._audio = new Audio(s.url);
        this._audio.play().catch(() => {});
        this._audio.onended = () => {
          this.setState({ playing: null, playPos: 0 });
        };
      } catch (e) {
        /* ignore */
      }
    }
    this._pStart = performance.now();
    this._pDur = Math.max(400, s.dur * 1000);
    this.setState({ playing: id, playPos: 0 });
    this._tick();
  }
  _tick() {
    if (this.state.playing == null) return;
    const t = (performance.now() - this._pStart) / this._pDur;
    if (t >= 1) {
      this.stopAudio();
      this.setState({ playing: null, playPos: 0 });
      return;
    }
    this.setState({ playPos: t });
    this._playRaf = requestAnimationFrame(() => this._tick());
  }
  stopAudio() {
    cancelAnimationFrame(this._playRaf);
    if (this._audio) {
      try {
        this._audio.pause();
      } catch (e) {
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
    this.state.tracks.forEach((t, i) => {
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

  /* ---------- view ---------- */
  render() {
    const st = this.state;
    const drag = st.drag;
    const presets = ['Drums', 'Percs', 'Hats', 'Cymbals', 'Bass', 'Sub', 'Lead', 'Pad', 'Keys', 'Vocals', 'FX'];

    // ----- left list ordered & grouped -----
    const byTrack: Record<string, Sample[]> = {};
    const unassigned: Sample[] = [];
    st.samples.forEach((s) => {
      const t = st.links[s.id];
      if (t && this.trackIndex(t) >= 0) (byTrack[t] = byTrack[t] || []).push(s);
      else unassigned.push(s);
    });

    const groups: { label: string; color: string; tid: string | null; idx?: number; list: Sample[] }[] = [];
    st.tracks.forEach((t, i) => {
      const list = byTrack[t.id];
      if (list && list.length)
        groups.push({ label: ('T' + (i + 1) + '  ' + (t.name || 'UNTITLED')).toUpperCase(), color: this.SHADE[i % 8], tid: t.id, idx: i, list });
    });
    if (unassigned.length) groups.push({ label: 'UNASSIGNED', color: '#7e7e86', tid: null, list: unassigned });

    interface SampleVM {
      id: string; name: string; time: string; bars: Bar[]; waveColor: string;
      playing: boolean; playheadX: number; playGlyph: string;
      onPlay: () => void; onDotDown: (e: React.MouseEvent) => void; onUnlink: () => void;
      linked: boolean; header: string | null; headerColor: string; headerCount: string;
      rowStyle: string; playStyle: string; dotStyle: string;
    }
    const samplesView: SampleVM[] = [];
    groups.forEach((g) => {
      g.list.forEach((s, idx) => {
        const linked = g.tid != null;
        const isDragSrc = !!drag && drag.sampleId === s.id;
        const playing = st.playing === s.id;
        samplesView.push({
          id: s.id,
          name: s.name,
          time: this.fmt(s.dur),
          bars: s.bars,
          waveColor: linked ? '#828289' : '#62626a',
          playing,
          playheadX: +(st.playPos * 100).toFixed(2),
          playGlyph: playing ? '■' : '▶',
          onPlay: () => this.play(s.id),
          onDotDown: (e) => this.startDrag(s.id, e),
          onUnlink: () => this.unlink(s.id),
          linked,
          header: idx === 0 ? g.label : null,
          headerColor: g.color,
          headerCount: idx === 0 ? String(g.list.length) : '',
          rowStyle: `display:flex;align-items:center;gap:12px;padding:9px 8px 9px 10px;border-radius:8px;margin-bottom:3px;background:${isDragSrc ? '#17171a' : 'transparent'};border:1px solid ${isDragSrc ? '#3a3a40' : 'transparent'};transition:background .08s;`,
          playStyle: `flex:0 0 auto;width:30px;height:30px;border-radius:50%;border:1px solid ${playing ? '#e9e9ec' : '#3a3a40'};background:${playing ? '#e9e9ec' : 'transparent'};color:${playing ? '#0b0b0c' : '#cfcfd4'};font-size:9px;display:flex;align-items:center;justify-content:center;cursor:pointer;padding-left:${playing ? '0' : '1px'};`,
          dotStyle: `width:13px;height:13px;border-radius:50%;border:1.5px solid ${linked || isDragSrc ? '#e9e9ec' : '#7e7e86'};background:${linked || isDragSrc ? '#e9e9ec' : 'transparent'};cursor:crosshair;`,
        });
      });
    });

    // ----- tracks -----
    interface TrackVM {
      id: string; label: string; name: string; idxColor: string;
      onName: (e: React.ChangeEvent<HTMLInputElement>) => void;
      onPreset: (e: React.ChangeEvent<HTMLSelectElement>) => void;
      assigned: { id: string; name: string; onRemove: () => void }[];
      hasSamples: boolean; empty: boolean; countLabel: string;
      cardStyle: string; dotStyle: string; ledStyle: string; swatchBorder: string;
    }
    const tracksView: TrackVM[] = st.tracks.map((t, i) => {
      const assigned = st.samples.filter((s) => st.links[s.id] === t.id);
      const has = assigned.length > 0;
      const hi = !!drag && st.overTrack === t.id;
      const shade = this.SHADE[i % 8];
      const dashCss = this.DASH[i % 8];
      const borderStyle = dashCss === '' ? 'solid' : dashCss.startsWith('1.5') || dashCss.startsWith('2.5') ? 'dotted' : 'dashed';
      return {
        id: t.id,
        label: 'T' + (i + 1),
        name: t.name,
        idxColor: has ? shade : '#7e7e86',
        onName: (e) => this.setTrackName(t.id, e.target.value),
        onPreset: (e) => {
          const v = e.target.value;
          if (v) this.setTrackName(t.id, v);
        },
        assigned: assigned.map((s) => ({ id: s.id, name: s.name, onRemove: () => this.unlink(s.id) })),
        hasSamples: has,
        empty: !has,
        countLabel: has ? assigned.length + '→ 1' : '—',
        cardStyle: `position:relative;background:${hi ? '#1a1a1e' : '#141416'};border:1px solid ${hi ? '#e9e9ec' : has ? '#3a3a40' : '#33333a'};border-radius:10px;padding:14px 16px 14px 16px;transition:border-color .1s,background .1s;`,
        dotStyle: `position:absolute;left:-7px;top:18px;width:13px;height:13px;border-radius:50%;border:1.5px solid ${has ? '#e9e9ec' : '#7e7e86'};background:${has ? shade : '#0d0d0f'};`,
        ledStyle: `width:7px;height:7px;border-radius:50%;background:${has ? '#e9e9ec' : 'transparent'};border:1px solid ${has ? '#e9e9ec' : '#3a3a40'};box-shadow:${has ? '0 0 6px rgba(255,255,255,0.5)' : 'none'};`,
        swatchBorder: `border-top:1.5px ${borderStyle} ${has ? shade : '#2a2a2e'};`,
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
        swatch: `flex:0 0 auto;width:24px;height:0;border-top:1.5px ${this.DASH[o.idx % 8] === '' ? 'solid' : this.DASH[o.idx % 8].startsWith('1.5') || this.DASH[o.idx % 8].startsWith('2.5') ? 'dotted' : 'dashed'} ${this.SHADE[o.idx % 8]};`,
        tick: done ? '✓' : cur ? '·' : '·',
        tickColor: done ? '#e9e9ec' : cur ? '#aaaab1' : '#7c7c86',
      };
    });
    const fOpt = (key: Format, label: string) => {
      const a = st.format === key;
      return {
        label,
        onSelect: () => this.setState({ format: key }),
        style: `background:${a ? '#e9e9ec' : 'transparent'};color:${a ? '#0b0b0c' : '#aaaab1'};border:none;border-radius:6px;font-size:11.5px;font-weight:${a ? '600' : '400'};padding:6px 13px;cursor:pointer;`,
      };
    };
    const formatOptions = [fOpt('16', '16-bit'), fOpt('24', '24-bit'), fOpt('source', 'Source')];

    const linked = Object.keys(st.links).filter((k) => this.trackIndex(st.links[k]) >= 0).length;
    const used = outs.length;
    const exportOK = used > 0;

    const uiSelect = drag ? 'none' : 'auto';
    const summary = `${linked}/${st.samples.length} linked  ·  ${used}/${st.tracks.length} tracks`;
    const exportBtnLabel = exportOK ? `Export → ${used} stems` : 'Export';
    const exportBtnStyle = `white-space:nowrap;background:${exportOK ? '#e9e9ec' : '#1c1c1f'};color:${exportOK ? '#0b0b0c' : '#7e7e86'};border:1px solid ${exportOK ? '#e9e9ec' : '#2a2a2e'};border-radius:7px;font-size:12.5px;font-weight:600;padding:9px 16px;cursor:${exportOK ? 'pointer' : 'not-allowed'};`;
    const runBtnStyle = `background:#e9e9ec;border:none;border-radius:7px;color:#0b0b0c;font-size:12.5px;font-weight:600;padding:9px 18px;cursor:pointer;`;

    return (
      <div
        ref={this.rootRef}
        style={css(
          `height:100vh;display:flex;flex-direction:column;background:#0b0b0c;color:#e9e9ec;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;user-select:${uiSelect};overflow:hidden;`,
        )}
      >
        {/* ============ HEADER ============ */}
        <header style={css('flex:0 0 auto;height:60px;display:flex;align-items:center;gap:22px;padding:0 22px;border-bottom:1px solid #1f1f22;background:#101012;')}>
          <div style={css('display:flex;align-items:center;gap:11px;')}>
            <div style={css('width:26px;height:26px;border:1.5px solid #92929a;border-radius:5px;display:flex;align-items:center;justify-content:center;')}>
              <div style={css('width:11px;height:11px;border-radius:50%;background:#e9e9ec;')}></div>
            </div>
            <div style={css("font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px;letter-spacing:2.5px;color:#e9e9ec;")}>STEM{NBSP}SQUASH</div>
          </div>

          <div style={css('width:1px;height:26px;background:#36363c;')}></div>

          <label style={css('display:flex;align-items:center;gap:10px;')}>
            <span style={css("font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:9.5px;letter-spacing:1.5px;color:#92929a;")}>PROJECT</span>
            <input
              value={st.projectName}
              onChange={(e) => this.setState({ projectName: e.target.value })}
              placeholder="Untitled Project"
              spellCheck={false}
              style={css('background:#0b0b0c;border:1px solid #2a2a2e;border-radius:6px;color:#f2f2f4;font-size:13.5px;font-weight:500;padding:7px 11px;width:230px;outline:none;')}
            />
          </label>

          <div style={css('flex:1 1 auto;')}></div>

          <div style={css("font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11px;letter-spacing:0.5px;color:#9c9ca4;")}>{summary}</div>

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
          <section onScroll={() => this.scheduleMeasure()} className="ss-scroll" style={css('flex:1 1 auto;min-width:400px;overflow-y:auto;background:#0d0d0f;border-right:1px solid #161619;')}>
            <div style={css('position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:13px 20px 12px 20px;background:#0d0d0f;border-bottom:1px solid #1a1a1d;')}>
              <span style={css("font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:10px;letter-spacing:2px;color:#a6a6ad;")}>SAMPLES</span>
              <span style={css('font-family:ui-monospace,monospace;font-size:10px;color:#7e7e86;')}>{String(st.samples.length)}</span>
              <div style={css('flex:1;')}></div>
              <button onClick={() => this.fileRef.current && this.fileRef.current.click()} style={css('display:flex;align-items:center;gap:6px;background:transparent;border:1px solid #2c2c30;border-radius:6px;color:#cfcfd4;font-size:11.5px;padding:6px 11px;cursor:pointer;')}>
                + Add files
              </button>
              <input ref={this.fileRef} onChange={(e) => this.onAdd(e)} type="file" accept="audio/*" multiple style={css('display:none;')} />
            </div>

            <div style={css('padding:8px 14px 40px 14px;')}>
              {samplesView.map((s) => (
                <div key={s.id}>
                  {s.header && (
                    <div style={css('display:flex;align-items:center;gap:9px;padding:14px 6px 7px 6px;')}>
                      <span style={css(`font-family:ui-monospace,monospace;font-size:9.5px;letter-spacing:1.6px;color:${s.headerColor};`)}>{s.header}</span>
                      <div style={css('flex:1;height:1px;background:#1c1c20;')}></div>
                      <span style={css('font-family:ui-monospace,monospace;font-size:9.5px;color:#78787f;')}>{s.headerCount}</span>
                    </div>
                  )}

                  <div style={css(s.rowStyle)}>
                    <button onClick={s.onPlay} title="Preview" style={css(s.playStyle)}>
                      {s.playGlyph}
                    </button>

                    <div style={css('flex:1;min-width:0;')}>
                      <div style={css('display:flex;align-items:baseline;gap:8px;')}>
                        <span style={css('font-size:13px;color:#ededf0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{s.name}</span>
                        <div style={css('flex:1;')}></div>
                        <span style={css('font-family:ui-monospace,monospace;font-size:10px;color:#8a8a91;flex:0 0 auto;')}>{s.time}</span>
                      </div>
                      <div style={css('margin-top:5px;height:28px;')}>
                        <svg viewBox="0 0 100 28" preserveAspectRatio="none" style={css('width:100%;height:28px;display:block;')}>
                          {s.bars.map((b, bi) => (
                            <rect key={bi} x={b.x} y={b.y} width={b.w} height={b.h} fill={s.waveColor}></rect>
                          ))}
                          {s.playing && <rect x={s.playheadX} y={0} width={0.7} height={28} fill="#ffffff"></rect>}
                        </svg>
                      </div>
                    </div>

                    <div style={css('display:flex;flex-direction:column;align-items:center;gap:6px;flex:0 0 auto;padding-left:4px;')}>
                      <div data-dot={'s:' + s.id} onMouseDown={s.onDotDown} title="Drag to a track" style={css(s.dotStyle)}></div>
                      {s.linked && (
                        <div onClick={s.onUnlink} title="Unlink" style={css('width:14px;height:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#92929a;font-size:12px;cursor:pointer;line-height:1;')}>
                          ×
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {st.samples.length === 0 && (
                <div style={css('text-align:center;color:#78787f;font-size:12.5px;padding:60px 20px;line-height:1.7;')}>
                  No samples loaded.
                  <br />
                  Add your exported stems to begin.
                </div>
              )}
            </div>
          </section>

          {/* gutter */}
          <div style={css('flex:0 0 132px;background:#08080a;')}></div>

          {/* ===== RIGHT : TRACKS ===== */}
          <section onScroll={() => this.scheduleMeasure()} className="ss-scroll" style={css('flex:0 0 452px;overflow-y:auto;background:#0d0d0f;border-left:1px solid #161619;')}>
            <div style={css('position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:13px 20px 12px 22px;background:#0d0d0f;border-bottom:1px solid #1a1a1d;')}>
              <span style={css("font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:10px;letter-spacing:2px;color:#a6a6ad;")}>
                OCTATRACK{NBSP}·{NBSP}TRACKS
              </span>
              <div style={css('flex:1;')}></div>
              <span style={css('font-family:ui-monospace,monospace;font-size:10px;color:#7e7e86;')}>{String(used)} active</span>
            </div>

            <div style={css('padding:12px 18px 40px 18px;display:flex;flex-direction:column;gap:11px;')}>
              {tracksView.map((t) => (
                <div key={t.id} data-track={t.id} style={css(t.cardStyle)}>
                  {/* target dot (anchored to left edge, into gutter) */}
                  <div data-dot={'t:' + t.id} style={css(t.dotStyle)}></div>

                  <div style={css('display:flex;align-items:center;gap:11px;')}>
                    <div style={css('display:flex;align-items:center;gap:8px;flex:0 0 auto;')}>
                      <span style={css(`font-family:ui-monospace,monospace;font-size:11px;letter-spacing:1px;color:${t.idxColor};font-weight:600;`)}>{t.label}</span>
                      <div style={css(t.ledStyle)}></div>
                    </div>

                    <input
                      value={t.name}
                      onChange={t.onName}
                      placeholder="name this track"
                      spellCheck={false}
                      style={css('flex:1;min-width:0;background:transparent;border:none;border-bottom:1px solid #36363c;color:#f2f2f4;font-size:14px;font-weight:500;padding:4px 2px;outline:none;')}
                    />

                    <select value="" onChange={t.onPreset} style={css('flex:0 0 auto;background:#141416;border:1px solid #2a2a2e;border-radius:6px;color:#aaaab1;font-size:11px;padding:6px 7px;outline:none;cursor:pointer;')}>
                      <option value="" disabled>
                        preset
                      </option>
                      {presets.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* line-identity + assigned */}
                  <div style={css('display:flex;align-items:center;gap:10px;margin-top:11px;')}>
                    <div style={css(`flex:0 0 40px;height:0;${t.swatchBorder}`)}></div>
                    {t.hasSamples && (
                      <div style={css('display:flex;flex-wrap:wrap;gap:6px;flex:1;')}>
                        {t.assigned.map((a) => (
                          <div key={a.id} style={css('display:flex;align-items:center;gap:6px;background:#141416;border:1px solid #2a2a2e;border-radius:5px;padding:4px 6px 4px 9px;')}>
                            <span style={css('font-size:11px;color:#cfcfd4;max-width:130px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{a.name}</span>
                            <div onClick={a.onRemove} title="Remove" style={css('color:#8a8a91;font-size:12px;cursor:pointer;line-height:1;')}>
                              ×
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {t.empty && <span style={css('flex:1;font-size:11.5px;color:#7c7c86;font-style:italic;')}>drag samples here to squash into one stem</span>}
                    <span style={css('flex:0 0 auto;font-family:ui-monospace,monospace;font-size:10px;color:#7e7e86;')}>{t.countLabel}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ============ EXPORT MODAL ============ */}
        {st.exportOpen && (
          <div onClick={() => this.closeExport()} style={css('position:fixed;inset:0;z-index:40;background:rgba(4,4,6,0.78);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);')}>
            <div onClick={(e) => e.stopPropagation()} style={css('width:540px;max-height:84vh;display:flex;flex-direction:column;background:#121214;border:1px solid #2c2c30;border-radius:12px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,0.6);')}>
              <div style={css('display:flex;align-items:center;gap:12px;padding:18px 22px;border-bottom:1px solid #1f1f22;')}>
                <span style={css('font-family:ui-monospace,monospace;font-size:11px;letter-spacing:2px;color:#e9e9ec;')}>EXPORT{NBSP}STEMS</span>
                <div style={css('flex:1;')}></div>
                <div onClick={() => this.closeExport()} style={css('color:#9c9ca4;font-size:18px;cursor:pointer;line-height:1;')}>
                  ×
                </div>
              </div>

              {/* CONFIG */}
              {st.exportPhase === 'config' && (
                <>
                  <div style={css('padding:18px 22px;overflow-y:auto;')} className="ss-scroll">
                    <div style={css('display:flex;align-items:center;gap:14px;margin-bottom:18px;')}>
                      <span style={css('font-family:ui-monospace,monospace;font-size:10px;letter-spacing:1px;color:#92929a;width:64px;')}>FORMAT</span>
                      <div style={css('display:flex;gap:4px;background:#0c0c0e;border:1px solid #36363c;border-radius:8px;padding:3px;')}>
                        {formatOptions.map((f) => (
                          <button key={f.label} onClick={f.onSelect} style={css(f.style)}>
                            {f.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={css('display:flex;align-items:center;gap:14px;margin-bottom:6px;')}>
                      <span style={css('font-family:ui-monospace,monospace;font-size:10px;letter-spacing:1px;color:#92929a;width:64px;')}>PROCESS</span>
                      <span style={css('font-size:12px;color:#aaaab1;')}>
                        Overlay-mix{NBSP}·{NBSP}normalize to −0.3{NBSP}dB
                      </span>
                    </div>

                    <div style={css('margin-top:18px;border-top:1px solid #1f1f22;padding-top:14px;')}>
                      <div style={css('font-family:ui-monospace,monospace;font-size:10px;letter-spacing:1px;color:#92929a;margin-bottom:10px;')}>
                        OUTPUT{NBSP}·{NBSP}{String(outs.length)} FILES → ./{st.projectName}/
                      </div>
                      {outputsView.map((o, k) => (
                        <div key={k} style={css('display:flex;align-items:center;gap:10px;padding:9px 11px;background:#0c0c0e;border:1px solid #202024;border-radius:7px;margin-bottom:7px;')}>
                          <div style={css(o.swatch)}></div>
                          <span style={css('font-family:ui-monospace,monospace;font-size:12px;color:#ededf0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{o.file}</span>
                          <span style={css('font-family:ui-monospace,monospace;font-size:10px;color:#8a8a91;')}>{o.srcLabel}</span>
                        </div>
                      ))}
                      {outs.length === 0 && <div style={css('color:#78787f;font-size:12.5px;padding:20px;text-align:center;')}>No tracks have samples assigned yet.</div>}
                    </div>
                  </div>
                  <div style={css('display:flex;gap:10px;padding:16px 22px;border-top:1px solid #1f1f22;')}>
                    <div style={css('flex:1;')}></div>
                    <button onClick={() => this.closeExport()} style={css('background:transparent;border:1px solid #2c2c30;border-radius:7px;color:#aaaab1;font-size:12.5px;padding:9px 16px;cursor:pointer;')}>
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
                  <div style={css('width:48px;height:48px;border:1.5px solid #e9e9ec;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px auto;font-size:22px;color:#e9e9ec;')}>✓</div>
                  <div style={css('font-size:15px;color:#f2f2f4;font-weight:500;margin-bottom:6px;')}>Squashed {String(outs.length)} stems</div>
                  <div style={css('font-family:ui-monospace,monospace;font-size:11px;color:#92929a;line-height:1.7;')}>
                    written to ./{st.projectName}/
                    <br />
                    ready for Octatrack import
                  </div>
                  {st.exportError ? (
                    <div style={css('margin-top:14px;font-size:10.5px;color:#c98a8a;font-style:italic;')}>export error · {st.exportError}</div>
                  ) : (
                    <div style={css('margin-top:14px;font-size:10.5px;color:#7c7c86;font-style:italic;')}>{(st.projectName || 'stems') + '.zip'} downloaded · overlay-mixed & normalized</div>
                  )}
                  <button onClick={() => this.closeExport()} style={css('margin-top:22px;background:#e9e9ec;border:none;border-radius:7px;color:#0b0b0c;font-size:12.5px;font-weight:600;padding:10px 24px;cursor:pointer;')}>
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
