# Jarvis — AI Desktop Assistant

A fully-featured, Iron Man-inspired AI desktop assistant built with Electron + Next.js. Jarvis combines a cinematic sci-fi HUD with a genuinely capable voice AI that can search the web, control your computer, generate images, play music, open documents, and much more — all via natural conversation.

<video controls width="100%">
  <source src="./intro.mp4" type="video/mp4">
</video>

---

## Features

### Voice AI
Speak to Jarvis and get spoken responses in real time. Two conversation backends are supported:

- **OpenAI Realtime** — Ultra-low-latency voice via OpenAI's WebRTC-based realtime API (`gpt-realtime-1.5`). Choose from three voices: Alloy, Echo, or Shimmer.
- **ElevenLabs Conversational AI** — Alternatively, use ElevenLabs' agent platform with support for custom agent IDs, system prompts, and first-message overrides.

Both modes support custom system instructions so you can shape Jarvis's personality and behavior.

### Sci-Fi HUD Interface
The UI is a fully animated heads-up display inspired by the Iron Man films:
- Animated rotating rings and arc reactor visuals
- Four visual themes: **Arc Reactor**, **Midnight**, **Crimson**, **Matrix**
- Grid overlay and repositionable UI elements
- Intro boot animation on first launch per session
- Alternate audio visualizers built with Three.js and React Three Fiber

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

### Image Context (Drag & Drop)
Drag and drop images directly into the interface. Jarvis receives them as visual context and can discuss or analyze their contents.

### Settings Panel
A full settings modal with multiple tabs:
- **Jarvis** — API keys, voice model selection, custom system instructions, ElevenLabs agent config
- **Abilities** — Toggle individual tools on or off
- **UI** — Theme, HUD layout, and visual options
- **System** — Diagnostics panel: platform info, shell detection, Python availability, and computer-use binary status

Settings are persisted in `localStorage` — no cloud account required.

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
