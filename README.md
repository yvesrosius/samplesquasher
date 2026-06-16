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
  named `<Project> - <Track name>.wav` (overlay-mixed, normalized to −0.3 dB),
  and run the export.

## Status

The export is currently a **simulated run** — it shows the full flow and file
list but does not yet write real WAVs. Real in-browser rendering
(decode → overlay-mix → normalize → WAV encode → download) is the next step.

This app is a faithful implementation of the **Stem Squash** design handed off
from [Claude Design](https://claude.ai/design).

## Development

```bash
npm install
npm run dev      # start the dev server
npm run build    # type-check + production build
npm run preview  # preview the production build
```

Built with Vite + React + TypeScript.
