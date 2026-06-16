# Stem Squash

A dark, monochrome desktop-style tool for collapsing many DAW stems
(Renoise, Ableton, …) onto the **Octatrack's 7–8 tracks**.

Export as many stems as you like from your DAW, then in Stem Squash assign
them to the handful of tracks the Octatrack actually has. Each output track is
named cleanly so the resulting files import tidily.

## How it works

- **Left — Samples.** Every loaded sample shows a waveform and a preview play
  button (animated playhead; real audio for files added via **+ Add files**).
- **Drag the ◦ dot** on a sample onto a track card to link it. A connector line
  is drawn and the sample jumps into that track's group, sorted directly across
  from its track.
- Since the UI is pure black & white, **each track gets its own line pattern +
  grey tone** (solid / dashed / dotted …) as the wayfinding system — mirrored on
  the track's swatch and on the connector line.
- **Right — Tracks.** Name each track, or pick from presets (Drums, Percs,
  Hats, Cymbals, Bass, Sub, Lead, Pad, Keys, Vocals, FX). An LED lights when a
  track has samples assigned.
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
