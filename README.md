# Jarvis — AI Desktop Assistant

A fully-featured, Iron Man-inspired AI desktop assistant built with Electron + Next.js. Jarvis combines a cinematic sci-fi HUD with a genuinely capable voice AI that can search the web, control your computer, generate images, play music, open documents, and much more — all via natural conversation.

[![Watch the intro](https://img.youtube.com/vi/BIF1FryGurE/maxresdefault.jpg)](https://youtu.be/BIF1FryGurE)

---

## Features

### Voice AI
Speak to Jarvis and get spoken responses in real time. Two conversation backends are supported:

- **OpenAI Realtime** — Ultra-low-latency voice via OpenAI's WebRTC-based realtime API (`gpt-realtime-2`). Choose from three voices: Alloy, Echo, or Shimmer.
- **ElevenLabs Conversational AI** — Alternatively, use ElevenLabs' agent platform with support for custom agent IDs, system prompts, and first-message overrides.

Both modes support custom system instructions so you can shape Jarvis's personality and behavior.

### Sci-Fi HUD Interface
The UI is a fully animated heads-up display inspired by the Iron Man films:
- Animated rotating rings and arc reactor visuals
- Five visual themes: **Arc Reactor**, **Midnight**, **Crimson**, **Matrix**, and **Custom** (pick any accent color)
- Grid overlay and repositionable UI elements
- Intro boot animation on first launch per session
- Alternate audio visualizers built with Three.js and React Three Fiber
- **Arc-reactor radial navigation** — the reactor button (bottom-left) blooms a full-screen radial menu with every page, plus lock / ambient / settings shortcuts
- **Command palette** — `⌘K` / `Ctrl+K` fuzzy-searches pages, widgets, and system actions
- **Ambient standby mode** — dims to a full-screen clock after an idle timeout (or on request); any input wakes it
- **Notification system** — unified HUD-styled toasts for timers, reminders, and layout events
- **USB touch-screen support (macOS)** — plug in a USB IR touch film/frame (e.g. ILITEK) and the desktop app reads the raw HID touch reports and turns them into taps and drags on the Jarvis window, even though macOS has no native touchscreen support. Auto-detects plug/unplug with a toast notification; may require a one-time Input Monitoring grant in System Settings

### PIN Lock Screen
An optional futuristic lock (Settings → Security): the screen blurs behind a large lock glyph inside a segmented reactor ring, with number bubbles floating on tether lines around it. Drag a bubble into the ring to enter that digit — the lock flashes the number and one of four PIN dots fills. A wrong PIN shakes the assembly, scatters the bubbles into new positions, and after three failures switches to a red intruder-alert state. Supports auto-lock after inactivity, keyboard entry, and voice lockdown ("Jarvis, lock it down") — but unlocking always requires the PIN on screen. While locked, Jarvis refuses tool calls.

### HUD Widgets
The HUD is made up of modular, draggable, and expandable widgets. Jarvis can open, close, and populate them via voice:

| Widget | Description |
|---|---|
| **Clock** | Live clock display |
| **System Status** | Faux system readout panel |
| **Network Graph** | Animated network visualization |
| **Map** | Location/map display |
| **3D Suit Viewer** | Interactive 3D Iron Man suit rendered from an STL model |
| **Music** | Media playback controls |
| **Text / Notes** | Jarvis can write text directly to the HUD |
| **PDF Viewer** | Jarvis can open PDFs inline in the HUD |
| **Image Viewer** | Displays AI-generated or drag-and-dropped images |
| **Camera** | Live webcam feed |
| **X-Ray** | Stylizes images with an X-ray effect via OpenAI image editing |
| **Photo Strip** | Photo capture and display |
| **Agenda** | Upcoming Google Calendar / iCal events and local tasks |
| **Tasks** | Today's to-do list (shared with the Calendar page and voice tools) |
| **Markets** | Live stock ticker with sparklines (Yahoo Finance, no key) |
| **Headlines** | Rotating world-news headlines (BBC RSS, no key) |
| **Timers** | Active countdowns and reminders with progress rings |
| **Weather Radar** | Animated precipitation radar (RainViewer + CARTO tiles, no keys) |
| **Camera Feed** | Persistent security-cam style webcam widget |
| **Comms Log** | Live transcript of your conversation with Jarvis |
| **Host Monitor** | TCP reachability + latency tiles for hosts you care about |
| **Orbital Tracker** | Live ISS ground track, sunrise/sunset, and moon phase |

Widget positions and sizes are **persisted across restarts**, and you can save/load **named layout presets** ("Jarvis, save this layout as workshop" / "switch to monitoring mode").

### AI Tools & Abilities
Jarvis has a full tool registry — things he can actually *do* when asked:

- **Web Search** — Searches DuckDuckGo and returns real results (no extra API key needed)
- **Image Generation** — Generates images using OpenAI's `gpt-image-2`, with optional prompt optimization via GPT-5
- **X-Ray Mode** — Stylizes any image to look like an X-ray scan
- **Computer Use** — Controls your computer autonomously using a Python agent, taking screenshots and sending keyboard/mouse input via `pyautogui`
- **Shell Commands** — Runs terminal commands on your machine (macOS and Windows compatible)
- **Music Control** — Controls Spotify and Apple Music via AppleScript on macOS; Windows media session support included
- **Datasheet Search** — Searches for and retrieves engineering/component datasheets as PDFs
- **Camera** — Accesses and displays your webcam feed
- **Open URL / Open PDF** — Jarvis can open links and documents on your behalf
- **HUD Control** — Jarvis can directly manipulate the HUD (open widgets, display text, clear panels)
- **Date/Time, Geolocation, Battery** — Reads live system data from the browser
- **Lock Interface** — "Lock it down" engages the PIN lock screen (unlock is on-screen only)
- **Timers & Reminders** — "Set a timer for 10 minutes", "remind me at 3pm to check the print" — persistent, with on-screen alerts and sound
- **Briefing** — "Morning briefing" delivers weather, schedule, headlines, and markets in one spoken summary while the matching widgets open
- **HUD Layouts** — Save and restore named widget arrangements by voice
- **Theme Control** — "Go crimson" switches the interface theme
- **Ambient Mode** — "Standby" dims to the ambient clock display

### Image Context (Drag & Drop)
Drag and drop images directly into the interface. Jarvis receives them as visual context and can discuss or analyze their contents.

### Settings Panel
A full settings modal with multiple tabs:
- **Jarvis** — API keys, voice model selection, custom system instructions, ElevenLabs agent config
- **Abilities** — Toggle individual tools on or off
- **UI** — Theme (including a custom accent color picker), ambient standby timeout, HUD layout, and visual options
- **Security** — Enable the PIN lock screen, set/reset your PIN, and configure auto-lock
- **System** — Diagnostics panel: platform info, shell detection, Python availability, and computer-use binary status

Settings are persisted in `localStorage` — no cloud account required. A **first-run setup wizard** walks new users through picking a voice engine, entering credentials, and setting a weather location.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS v4 |
| Desktop shell | Electron 36 |
| 3D graphics | Three.js, React Three Fiber, Drei |
| Animations | Framer Motion |
| AI — voice | OpenAI Realtime API, ElevenLabs Conversational AI |
| AI — vision/image | OpenAI Images API (`gpt-image-2`) |
| AI — computer use | OpenAI `gpt-5.4` + `computer` tool, Python (`mss`, `pyautogui`) |

---

## Development

```bash
npm install
npm run dev
```

This starts the Next.js dev server and Electron simultaneously.

---

## Build & Package

### macOS (DMG)
```bash
npm run dist:mac
```
Outputs a `.dmg` installer in `release/` for arm64 and x64.

### Windows (EXE / NSIS installer)
```bash
npm run dist:win
```
Outputs an NSIS `.exe` installer in `release/`.

### Both platforms
```bash
npm run dist
```

---

## Requirements

- **Node.js 18+**
- **Python 3** with the following packages installed (required for computer-use):
  ```bash
  pip install mss pyautogui openai Pillow
  ```
- **OpenAI API key** — enter in the Settings panel at runtime, or set via environment variable

---

## Environment

Copy `env.example` to `.env.local` for local development:

```bash
cp env.example .env.local
```

```
NEXT_PUBLIC_OPENAI_API_KEY=sk-proj-...
```

The API key can also be entered directly in the Settings modal and is stored in `localStorage` — no `.env` file is required at runtime.

---

## App Icons

Place your app icons in `buildfiles/`:
- `icon.icns` — macOS
- `icon.ico` — Windows
- `icon.png` — Fallback (512×512 recommended)

If no icons are present, electron-builder will use defaults.

---

## Project Structure

```
├── app/                   # Next.js app (UI, API routes, components)
│   ├── components/        # JarvisAssistant, HUD widgets, visualizers
│   ├── lib/               # Tool registry, SFX, search, PDF helpers
│   └── api/               # Server routes (image gen, shell, music, etc.)
├── electron/              # Electron main process and preload
├── scripts/               # Python computer-use agent
├── public/                # Static assets (models, SFX, logos)
├── buildfiles/            # App icons for packaging
└── release/               # Packaged installer output
```
