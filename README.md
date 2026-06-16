# Stem Squash

A dark, monochrome desktop-style tool for collapsing many DAW stems
(Renoise, Ableton, …) onto the **Octatrack's 7–8 tracks**.

Export as many stems as you like from your DAW, then in Stem Squash assign
them to the handful of tracks the Octatrack actually has. Each output track is
named cleanly so the resulting files import tidily.

## How it works

- **Left — Samples.** Every loaded sample shows a real peak waveform and a
  preview play / stop button. Click anywhere on a waveform to **scrub** to that
  point (it seeks the real audio); the playhead sweeps as it plays.
- **Drag a whole sample card** onto a track card to link it — the entire card is
  the grab handle, not just the connector dot. A patterned connector line is
  drawn and the sample jumps into that track's group.
- **Samples linked to the same track collapse into one stacked card** so a busy
  list stays tidy; click the stack (or the ▶ on its group header) to unfold and
  manage the individual samples, then fold it back up.
- Since the UI is pure black & white, **each track gets its own line pattern +
  grey tone** (solid / dashed / dotted …) as the wayfinding system — mirrored on
  the track's swatch and on the connector line.
- **Right — Tracks.** Name each track with the combined name-and-preset field
  (presets: Drums, Percs, Hats, Cymbals, Bass, Sub, Lead, Pad, Keys, Vocals,
  FX). An LED lights when a track has samples assigned.
- **T8 master.** Toggle **T8 master** in the header to treat the last track as
  the master bus — it is shown disabled and is excluded from drops, counts and
  the export.
- **Export.** Choose **16-bit / 24-bit / source**, review the exact output files
  named `<Project> - <Track name>.wav`, and run the export. Each track is
  rendered for real, entirely in the browser:
  **decode → overlay-mix → normalize to −0.3 dBFS → WAV encode**, then all the
  files are packaged into `<Project>.zip` (containing a `<Project>/` folder) and
  downloaded — ready to unzip onto your Octatrack's CompactFlash.

## How the export works

- Sources are decoded through an `OfflineAudioContext`, which resamples every
  input to a common rate so mixing never has to resample by hand.
- A track's samples are summed (overlay mix, length = the longest source), then
  the result is normalized so its peak sits at −0.3 dBFS.
- The mix is encoded to WAV: **16-bit** or **24-bit** PCM, or **32-bit float**
  for "source".
- Files are bundled with a small, dependency-free STORE-method ZIP writer (WAV
  is already uncompressed, so deflating it would add weight for no real gain).
- Each added file is decoded once on load to derive its real duration and a
  real peak waveform; that decoded buffer is cached and reused at export time.
  The waveform peak scan is bounded (a fixed sample budget with a stride), so a
  long stem analyzes about as fast as a short one and the UI stays responsive
  when many or long samples are loaded at once.

This app is a faithful implementation of the **Stem Squash** design handed off
from [Claude Design](https://claude.ai/design), with the export wired up for
real.

## Development

```bash
npm install
npm run dev      # start the dev server
npm run build    # type-check + production build
npm run preview  # preview the production build
```

Built with Vite + React + TypeScript.

## Deployment

The app is a fully static client-side bundle (all audio processing runs in the
browser), so it deploys to **GitHub Pages**. A workflow at
`.github/workflows/deploy.yml` builds and publishes on every push to the
default branch, and the production build is based at `/samplesquasher/` to match
the project-site URL:

**https://yvesrosius.github.io/samplesquasher/**

One-time setup (the workflow's token can't enable Pages itself):

1. Make the repository **public** (Pages on a private repo needs a paid plan).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.

After that, every push to the default branch builds and publishes automatically.

