/** Paths from Settings → System — sent with shell / computer-use API calls. */
export function readToolkitOverrides(): {
  shellPathOverride?: string;
  pythonPathOverride?: string;
} {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem('jarvis_settings');
    if (!raw) return {};
    const s = JSON.parse(raw) as Record<string, unknown>;
    const shell =
      typeof s.shellPathOverride === 'string' && s.shellPathOverride.trim()
        ? s.shellPathOverride.trim()
        : undefined;
    const py =
      typeof s.pythonPathOverride === 'string' && s.pythonPathOverride.trim()
        ? s.pythonPathOverride.trim()
        : undefined;
    const out: { shellPathOverride?: string; pythonPathOverride?: string } = {};
    if (shell) out.shellPathOverride = shell;
    if (py) out.pythonPathOverride = py;
    return out;
  } catch {
    return {};
  }
}

export interface JarvisFunction {
  name: string;
  label: string;
  description: string;
  tool: {
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export const FUNCTION_REGISTRY: JarvisFunction[] = [
  {
    name: 'get_date',
    label: 'Get Date',
    description: 'Tell Jarvis the current date when asked',
    tool: {
      type: 'function',
      name: 'get_date',
      description: 'Get the current date',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: () => ({
      date: new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    }),
  },
  {
    name: 'get_time',
    label: 'Get Time',
    description: 'Tell Jarvis the current time when asked',
    tool: {
      type: 'function',
      name: 'get_time',
      description: 'Get the current local time',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: () => ({
      time: new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    }),
  },
  {
    name: 'get_location',
    label: 'Get Location',
    description: "Tell Jarvis the user's current GPS location when asked",
    tool: {
      type: 'function',
      name: 'get_location',
      description: "Get the user's current geographic location (latitude and longitude)",
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: () =>
      new Promise((resolve) => {
        if (!navigator.geolocation) {
          resolve({ error: 'Geolocation is not supported by this browser.' });
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (pos) =>
            resolve({
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy_meters: Math.round(pos.coords.accuracy),
            }),
          (err) => resolve({ error: err.message }),
          { timeout: 8000 }
        );
      }),
  },
  {
    name: 'get_battery_level',
    label: 'Get Battery Level',
    description: "Tell Jarvis the user's current device battery level when asked",
    tool: {
      type: 'function',
      name: 'get_battery_level',
      description: "Get the user's current device battery level and charging status",
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => {
      if (!('getBattery' in navigator)) {
        return { error: 'Battery API is not supported on this device or browser.' };
      }
      try {
        const battery = await (navigator as Navigator & {
          getBattery: () => Promise<{ level: number; charging: boolean }>;
        }).getBattery();
        return {
          level_percent: Math.round(battery.level * 100),
          charging: battery.charging,
        };
      } catch {
        return { error: 'Could not read battery status.' };
      }
    },
  },
  {
    name: 'computer_use',
    label: 'Computer Use',
    description: "Let Jarvis control your computer to complete tasks (e.g. 'Open Discord')",
    tool: {
      type: 'function',
      name: 'computer_use',
      description:
        'Control the user\'s computer to complete a task. Use this when the user asks you to open an app, click something, type something, or perform any action on their screen.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A clear description of what to do on the computer, e.g. "Open Discord"',
          },
        },
        required: ['task'],
      },
    },
    handler: async (args) => {
      const task = args.task as string;
      if (!task) return { error: 'No task provided.' };

      const stored = localStorage.getItem('jarvis_settings');
      const apiKey = stored ? JSON.parse(stored).apiKey : '';
      if (!apiKey) return { error: 'No API key found in settings.' };

      try {
        const res = await fetch('/api/computer-use', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task, apiKey, ...readToolkitOverrides() }),
        });
        return await res.json();
      } catch (err) {
        return { error: String(err) };
      }
    },
  },
  {
    name: 'xray',
    label: 'X-Ray',
    description: "Let Jarvis capture your camera and generate an X-ray scan of what it sees",
    tool: {
      type: 'function',
      name: 'xray',
      description: "Capture the user's camera and generate an X-ray image showing what's inside the object they're pointing at.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => {
      const XRAY_EVENT = 'jarvis:xray';

      const dispatch = (detail: object) =>
        window.dispatchEvent(new CustomEvent(XRAY_EVENT, { detail }));

      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });

        // Grab a single frame via an offscreen canvas
        const video = document.createElement('video');
        video.srcObject = stream;
        await new Promise<void>((res) => { video.onloadedmetadata = () => res(); });
        await video.play();

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d')!.drawImage(video, 0, 0);
        const imageBase64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];

        // Stop camera immediately after capture
        stream.getTracks().forEach((t) => t.stop());
        stream = null;

        // Show scanning widget with the captured camera image underneath
        dispatch({ state: 'scanning', capturedBase64: imageBase64 });

        const stored = localStorage.getItem('jarvis_settings');
        const apiKey = stored ? JSON.parse(stored).apiKey : '';
        if (!apiKey) {
          dispatch({ state: 'error', error: 'No API key found in settings.' });
          return { error: 'No API key.' };
        }

        const res = await fetch('/api/xray', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64, apiKey }),
        });

        const data = await res.json();

        if (data.error) {
          dispatch({ state: 'error', error: data.error });
          return { error: data.error };
        }

        dispatch({ state: 'done', imageBase64: data.imageBase64 });
        return { result: 'X-ray scan complete. Image displayed.' };
      } catch (err) {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        const msg = String(err);
        dispatch({ state: 'error', error: msg });
        return { error: msg };
      }
    },
  },
  {
    name: 'image_generation',
    label: 'Image Generation',
    description:
      'Generate an image from a text prompt with GPT Image (gpt-image-2) and show it in an HUD widget',
    tool: {
      type: 'function',
      name: 'image_generation',
      description:
        "Generate an image from the user's description using OpenAI GPT Image (gpt-image-2). This first improves the prompt with GPT-5.5 for better image quality, then renders the image. If the user has added images on the home screen, you can use the latest one as visual reference context. Opens an IMAGE widget on the HUD while generating and shows the result when ready.",
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed description of the image to generate.',
          },
          size: {
            type: 'string',
            enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'],
            description: 'Output dimensions. Omit for 1024×1024.',
          },
          quality: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'auto'],
            description: 'Rendering quality. Omit for automatic.',
          },
          enhance_prompt: {
            type: 'boolean',
            description:
              'When true (default), improve the image prompt with GPT-5.5 before generating.',
          },
          use_latest_home_image: {
            type: 'boolean',
            description:
              'When true (default), use the most recent image shown on the home screen as reference context if available.',
          },
          reference_image_base64: {
            type: 'string',
            description:
              'Optional explicit reference image as base64 (or full data URL). If provided, this is used instead of latest home image.',
          },
        },
        required: ['prompt'],
      },
    },
    handler: async (args) => {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) return { error: 'No prompt provided.' };

      const stored = localStorage.getItem('jarvis_settings');
      const apiKey = stored ? JSON.parse(stored).apiKey : '';
      if (!apiKey) return { error: 'No API key found in settings.' };

      const moduleId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `img-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

      const caption = prompt.length > 280 ? `${prompt.slice(0, 280)}…` : prompt;
      const photoContext = (
        window as Window & {
          __jarvisPhotoContext?: { latestDataUrl?: string; photos: string[] };
        }
      ).__jarvisPhotoContext;
      const explicitRef = typeof args.reference_image_base64 === 'string' ? args.reference_image_base64.trim() : '';
      const useLatest = args.use_latest_home_image !== false;
      const fallbackRef = useLatest ? photoContext?.latestDataUrl : undefined;
      const referenceImageBase64 = explicitRef || fallbackRef;

      window.dispatchEvent(
        new CustomEvent('jarvis:hud', {
          detail: {
            command: 'open',
            widget: 'image',
            module_id: moduleId,
            image_loading: true,
            title: 'GENERATING…',
            image_caption: caption,
          },
        })
      );

      try {
        const res = await fetch('/api/image-generation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            apiKey,
            size: args.size,
            quality: args.quality,
            referenceImageBase64,
            enhancePrompt: args.enhance_prompt !== false,
          }),
        });

        const data = (await res.json()) as {
          error?: string;
          imageBase64?: string;
          optimizedPrompt?: string;
          optimizedTitle?: string | null;
          optimizerModel?: string | null;
        };

        if (data.error) {
          window.dispatchEvent(
            new CustomEvent('jarvis:hud', {
              detail: {
                command: 'set_image',
                id: moduleId,
                image_error: data.error,
              },
            })
          );
          return { error: data.error };
        }

        if (!data.imageBase64) {
          const fallback = 'No image data returned.';
          window.dispatchEvent(
            new CustomEvent('jarvis:hud', {
              detail: {
                command: 'set_image',
                id: moduleId,
                image_error: fallback,
              },
            })
          );
          return { error: fallback };
        }

        const headerSource = data.optimizedTitle?.trim() || prompt;
        const header = headerSource.length > 36 ? `${headerSource.slice(0, 36)}…` : headerSource;

        window.dispatchEvent(
          new CustomEvent('jarvis:hud', {
            detail: {
              command: 'set_image',
              id: moduleId,
              image_base64: data.imageBase64,
              title: header.toUpperCase(),
            },
          })
        );

        return {
          success: true,
          used_reference_image: !!referenceImageBase64,
          prompt_enhanced: args.enhance_prompt !== false,
          optimized_prompt: data.optimizedPrompt,
          optimizer_model: data.optimizerModel,
          message: referenceImageBase64
            ? 'Image generated using reference image context and displayed in the IMAGE widget on the HUD.'
            : 'Image generated and displayed in the IMAGE widget on the HUD.',
        };
      } catch (err) {
        const msg = String(err);
        window.dispatchEvent(
          new CustomEvent('jarvis:hud', {
            detail: {
              command: 'set_image',
              id: moduleId,
              image_error: msg,
            },
          })
        );
        return { error: msg };
      }
    },
  },
  {
    name: '3d_printing',
    label: '3D Printing',
    description: 'Let Jarvis find a model and send a 3D print job via Bambu Studio',
    tool: {
      type: 'function',
      name: '3d_printing',
      description: "Start a 3D print job. Use this when the user asks to print something. The user just needs to describe what they want to print.",
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'What the user wants to print, e.g. "a command strip" or "a Batman costume"',
          },
        },
        required: ['description'],
      },
    },
    handler: async (args) => {
      const description = args.description as string;
      if (!description) return { error: 'No print description provided.' };

      const stored = localStorage.getItem('jarvis_settings');
      const apiKey = stored ? JSON.parse(stored).apiKey : '';
      if (!apiKey) return { error: 'No API key found in settings.' };

      const task = `${description}. Open Bambu Studio, go to the online models tab. Find a model matching the user's description. Pick a relevant one. Load the model. Check the available printers using the device tab at the top. Find one not in use. Set the printer. Slice the file, and send it to the correct printer. If you get stuck with an incompatible printer error, then select the drop down and choose the printer you selected. Do not ask follow-up questions unless the file is missing or there are zero available printers. Make reasonable choices and complete the print job. If there are multiple idle printers, choose the first idle one. Stop only after the print job has been successfully sent, or if the file cannot be found, no printer is available, or Bambu Studio blocks the job with an error that cannot be resolved.`;

      try {
        const res = await fetch('/api/computer-use', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task, apiKey, ...readToolkitOverrides() }),
        });
        return await res.json();
      } catch (err) {
        return { error: String(err) };
      }
    },
  },
  {
    name: 'run_shell_command',
    label: 'Shell / Terminal',
    description: 'Let Jarvis run terminal commands to open apps, manage files, and control the system',
    tool: {
      type: 'function',
      name: 'run_shell_command',
      description:
        "Execute one or more shell commands on the user's computer. " +
        "Use this to open applications, manage files, run scripts, get system info, or perform any task that can be done in a terminal. " +
        "On macOS use zsh syntax (e.g. 'open -a Discord'). On Windows use cmd/PowerShell syntax. " +
        "For multi-step tasks, chain commands with && or call this function multiple times. " +
        "Prefer this over computer_use for anything that can be done via command line — it is faster and more reliable.",
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              "The shell command to run. Examples: " +
              "'open -a \"Google Chrome\"' to open Chrome on Mac, " +
              "'open -a \"Visual Studio Code\" /path/to/folder' to open a folder in VS Code, " +
              "'say \"Hello\"' to speak text on Mac, " +
              "'ls ~/Desktop' to list files, " +
              "'mkdir ~/Desktop/NewFolder' to create a folder, " +
              "'osascript -e \\'set volume output volume 50\\'' to set volume on Mac.",
          },
        },
        required: ['command'],
      },
    },
    handler: async (args) => {
      const command = args.command as string;
      if (!command) return { error: 'No command provided.' };

      try {
        const res = await fetch('/api/shell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, ...readToolkitOverrides() }),
        });
        return await res.json();
      } catch (err) {
        return { error: String(err) };
      }
    },
  },
  {
    name: 'web_search',
    label: 'Web Search',
    description: 'Let Jarvis search the web and return real-time results',
    tool: {
      type: 'function',
      name: 'web_search',
      description:
        'Search the web for current information, news, facts, or anything the user wants to look up. Returns a list of results with title, url, and snippet fields. Summarize the most relevant results in your response.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query, e.g. "latest iPhone release date"',
          },
        },
        required: ['query'],
      },
    },
    handler: async (args) => {
      const query = args.query as string;
      if (!query) return { error: 'No query provided.' };
      try {
        const res = await fetch('/api/web-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        return await res.json();
      } catch (err) {
        return { error: String(err) };
      }
    },
  },
  {
    name: 'take_photo',
    label: 'Camera',
    description: "Let Jarvis take a photo with your camera and display it on screen",
    tool: {
      type: 'function',
      name: 'take_photo',
      description:
        "Take a photo using the user's camera and display it on screen. Use this when the user asks you to look at something, take a picture, capture something, or see what's in front of them. Do NOT use this for X-ray scans — use the xray function for that.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => {
      const dispatch = (detail: object) =>
        window.dispatchEvent(new CustomEvent('jarvis:camera', { detail }));

      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });

        const video = document.createElement('video');
        video.srcObject = stream;
        await new Promise<void>((res) => { video.onloadedmetadata = () => res(); });
        await video.play();

        // Brief flash to indicate capture
        dispatch({ state: 'capturing' });
        await new Promise((res) => setTimeout(res, 600));

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d')!.drawImage(video, 0, 0);
        const imageBase64 = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];

        stream.getTracks().forEach((t) => t.stop());
        stream = null;

        dispatch({ state: 'done', imageBase64 });
        return { result: 'Photo captured. Describe what you see in the image.', imageBase64 };
      } catch (err) {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        const msg = String(err);
        dispatch({ state: 'error', error: msg });
        return { error: msg };
      }
    },
  },
  {
    name: 'control_music',
    label: 'Music Control',
    description: 'Let Jarvis control music playback (play, pause, skip, volume)',
    tool: {
      type: 'function',
      name: 'control_music',
      description:
        "Control music playback. Works with Spotify and Apple Music on macOS. On Windows 10/11 uses the system media session (Spotify, Groove, Microsoft Edge tabs, etc.). Commands: 'playpause', 'play', 'pause', 'next', 'previous', 'volume_up', 'volume_down', 'volume' (0-100; on Windows, volume keys adjust system volume).",
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: ['playpause', 'play', 'pause', 'next', 'previous', 'volume_up', 'volume_down', 'volume'],
            description: 'The playback command to execute.',
          },
          value: {
            type: 'number',
            description: 'Volume level 0-100. Only required for the "volume" command.',
          },
        },
        required: ['command'],
      },
    },
    handler: async (args) => {
      try {
        const res = await fetch('/api/music', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        const data = await res.json();
        if (data.error) return { error: data.error };
        // After any control action, fire an update so the widget refreshes
        window.dispatchEvent(new CustomEvent('jarvis:music:refresh'));
        return { success: true, command: args.command };
      } catch (err) {
        return { error: String(err) };
      }
    },
  },
  {
    name: 'get_now_playing',
    label: 'Now Playing',
    description: "Let Jarvis check and display what's currently playing",
    tool: {
      type: 'function',
      name: 'get_now_playing',
      description:
        "Get the currently playing track (title, artist, album). On macOS: Spotify / Apple Music / system Now Playing. On Windows: whatever app owns the system media session (e.g. Spotify, Edge). Opens the music widget when invoked.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => {
      try {
        const res = await fetch('/api/music');
        const data = await res.json();
        if (data.error) return { error: data.error };
        // Open the music widget and pass it the track data
        window.dispatchEvent(new CustomEvent('jarvis:music:update', { detail: data }));
        return {
          title:     data.title,
          artist:    data.artist,
          album:     data.album,
          isPlaying: data.isPlaying,
          app:       data.app,
        };
      } catch (err) {
        return { error: String(err) };
      }
    },
  },
  {
    name: 'show_hud_text',
    label: 'HUD Text Note',
    description: 'Let Jarvis show chosen text in a TEXT NOTE widget on the HUD',
    tool: {
      type: 'function',
      name: 'show_hud_text',
      description:
        "Display a TEXT NOTE widget on the user's HUD with specific content. Use when the user asks you to write something on screen, pin notes, show a reminder, or display text visibly alongside the interface.",
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The full text body to show in the widget.',
          },
          title: {
            type: 'string',
            description:
              "Optional short title shown in the widget header (e.g. 'REMINDER'). If omitted, the default TEXT NOTE title is used.",
          },
        },
        required: ['content'],
      },
    },
    handler: (args) => {
      const content = args.content as string;
      if (content === undefined || content === null || String(content).trim() === '') {
        return { error: 'Provide non-empty content.' };
      }
      window.dispatchEvent(
        new CustomEvent('jarvis:hud', {
          detail: {
            command: 'open',
            widget: 'text',
            text: String(content),
            title: args.title as string | undefined,
          },
        })
      );
      return { success: true };
    },
  },
  {
    name: 'control_hud',
    label: 'HUD Control',
    description: 'Let Jarvis open, close, or reset widgets on the home screen',
    tool: {
      type: 'function',
      name: 'control_hud',
      description:
        "Control the HUD widgets displayed on the home screen. Use this when the user asks to open, close, show, hide, or manage widgets. " +
        "Commands: 'open' adds a widget, 'close' removes a widget, 'clear' removes all widgets, 'reset' restores the default layout. " +
        "Widget names: 'clock', 'system', 'network', 'map', 'suit', 'music', 'text', 'pdf', 'image', 'terminal'. " +
        "IMPORTANT: The 'map' widget here is a small HUD minimap overlay — it is NOT the full Jarvis Map page. " +
        "If the user asks to 'open the map', 'go to the map page', 'show the map', 'navigate on a map', or wants to fly to a location/draw a route, use map_command instead. " +
        "When opening the 'text' widget, optionally supply text_content and title. " +
        "When opening the 'pdf' widget, supply pdf_source (https URL, site path like /file.pdf, or absolute filesystem path in the desktop app).",
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: ['open', 'close', 'clear', 'reset'],
            description: "The action to perform: 'open' a widget, 'close' a widget, 'clear' all widgets, or 'reset' to default layout.",
          },
          widget: {
            type: 'string',
            enum: ['clock', 'system', 'network', 'map', 'suit', 'music', 'text', 'pdf', 'image', 'terminal'],
            description: "The widget to open or close. Required for 'open' and 'close' commands. Ignored for 'clear' and 'reset'. Use 'terminal' to show the error terminal.",
          },
          text_content: {
            type: 'string',
            description:
              "When command is 'open' and widget is 'text', the body text to display. Omit for an empty note or when opening other widgets.",
          },
          pdf_source: {
            type: 'string',
            description:
              "When command is 'open' and widget is 'pdf', the document location: https URL, path under public (e.g. /brochure.pdf), or absolute file path (desktop app).",
          },
          title: {
            type: 'string',
            description:
              "When opening the 'text' widget, optional header title. Ignored for other widget types.",
          },
        },
        required: ['command'],
      },
    },
    handler: (args) => {
      const command = args.command as string;
      const widget = args.widget as string | undefined;
      const text_content = args.text_content as string | undefined;
      const title = args.title as string | undefined;
      const pdf_source = args.pdf_source as string | undefined;

      if ((command === 'open' || command === 'close') && !widget) {
        return { error: 'A widget name is required for open/close commands.' };
      }

      if (command === 'open' && widget === 'pdf' && !(pdf_source ?? '').trim()) {
        return { error: 'Opening the PDF widget requires pdf_source (URL or file path).' };
      }

      window.dispatchEvent(
        new CustomEvent('jarvis:hud', {
          detail: { command, widget, text: text_content, title, pdf_source },
        })
      );
      return { success: true, command, widget };
    },
  },
  {
    name: 'open_url',
    label: 'Open URL',
    description: 'Let Jarvis open a website or URL in a new browser tab',
    tool: {
      type: 'function',
      name: 'open_url',
      description: 'Open a URL in a new browser tab',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to open, e.g. https://example.com',
          },
        },
        required: ['url'],
      },
    },
    handler: (args) => {
      const url = args.url as string;
      if (!url) return { error: 'No URL provided.' };
      window.open(url, '_blank', 'noopener,noreferrer');
      return { opened: url };
    },
  },
  {
    name: 'open_pdf',
    label: 'Open PDF',
    description: 'Show a PDF in the HUD document viewer (expandable); accepts a URL or file path',
    tool: {
      type: 'function',
      name: 'open_pdf',
      description:
        'Open a PDF in the on-screen HUD viewer. Use when the user wants to view, show, or display a PDF. ' +
        'source may be a full https URL, a site path served from public (e.g. /manual.pdf), or an absolute filesystem path when running the Jarvis desktop app.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description:
              'PDF location: https://… URL, /path/from/public folder, or absolute file path (e.g. /Users/me/doc.pdf or C:\\Users\\me\\doc.pdf)',
          },
          title: {
            type: 'string',
            description: 'Optional short title shown in the widget header (defaults to DOCUMENT).',
          },
        },
        required: ['source'],
      },
    },
    handler: (args) => {
      const source = args.source as string;
      if (!source?.trim()) return { error: 'No PDF source provided.' };
      window.dispatchEvent(
        new CustomEvent('jarvis:hud', {
          detail: {
            command: 'open',
            widget: 'pdf',
            pdf_source: source.trim(),
            title: args.title as string | undefined,
          },
        })
      );
      return { success: true };
    },
  },
  {
    name: 'find_datasheet',
    label: 'Find datasheet',
    description:
      'Search the web for an official manufacturer PDF datasheet and open it in the HUD viewer (no distributor API keys)',
    tool: {
      type: 'function',
      name: 'find_datasheet',
      description:
        'Find and display a component / board datasheet as a PDF. Uses public web search (DuckDuckGo HTML), ' +
        'prefers direct .pdf links on manufacturer sites (e.g. raspberrypi.com, espressif.com, ti.com, st.com, arduino.cc, revrobotics.com) ' +
        'and deprioritizes scraper mirrors. Use when the user asks for a datasheet, product brief, reference manual, or pinout PDF for a named part or dev board. ' +
        'Pass the clearest part or product string they gave (e.g. "Raspberry Pi 5", "ESP32-S3-WROOM-1").',
      parameters: {
        type: 'object',
        properties: {
          part_name: {
            type: 'string',
            description:
              'Part number, module name, or product name to look up (e.g. "Raspberry Pi 5", "Arduino Uno R4", "STM32F407").',
          },
          title: {
            type: 'string',
            description: 'Optional HUD panel title override; otherwise a default "DATASHEET — …" header is used.',
          },
        },
        required: ['part_name'],
      },
    },
    handler: async (args) => {
      const part_name = args.part_name as string;
      if (!part_name?.trim()) return { error: 'No part_name provided.' };

      try {
        const res = await fetch('/api/datasheet-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ part_name: part_name.trim() }),
        });
        const data = (await res.json()) as {
          error?: string;
          best_url?: string | null;
          best_title?: string | null;
          best_score?: number | null;
          queries_run?: string[];
          alternatives?: { url: string; title: string; score: number }[];
        };

        if (!res.ok) {
          return {
            error: typeof data.error === 'string' ? data.error : `Datasheet search failed (HTTP ${res.status}).`,
          };
        }

        if (!data.best_url) {
          return {
            error: 'No direct PDF URL found in search results.',
            hint:
              'Try a more specific part number, or use web_search for HTML documentation pages and then open_pdf if you get a PDF link.',
            queries_run: data.queries_run,
            alternatives: data.alternatives?.slice(0, 5),
          };
        }

        const customTitle = (args.title as string | undefined)?.trim();
        const headerTitle = customTitle
          ? customTitle.toUpperCase()
          : `DATASHEET — ${part_name.trim().toUpperCase()}`;

        window.dispatchEvent(
          new CustomEvent('jarvis:hud', {
            detail: {
              command: 'open',
              widget: 'pdf',
              pdf_source: data.best_url,
              title: headerTitle,
            },
          })
        );

        return {
          success: true,
          opened_url: data.best_url,
          title: data.best_title,
          score: data.best_score,
          alternatives: data.alternatives?.slice(0, 4),
        };
      } catch (err) {
        return { error: String(err) };
      }
    },
  },
  {
    name: 'navigate_to_page',
    label: 'Navigate to Page',
    description: 'Switch Jarvis to a different view — e.g. open the live news feed and stock ticker',
    tool: {
      type: 'function',
      name: 'navigate_to_page',
      description:
        'Navigate Jarvis to a different page. Use for "home" or "news" only. ' +
        '"news" opens the live news feed with streaming video and market data. ' +
        '"home" returns to the main Jarvis home screen. ' +
        'NEVER use this for map or location requests — use map_command instead.',
      parameters: {
        type: 'object',
        properties: {
          page: {
            type: 'string',
            enum: ['home', 'news'],
            description: '"home" = main Jarvis view. "news" = live news + stocks feed.',
          },
        },
        required: ['page'],
      },
    },
    handler: async (args) => {
      const page = args.page as string;
      if (!page) return { error: 'No page specified.' };
      window.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { page: page } }));

      if (page === 'news') {
        try {
          const res = await fetch('/api/news-headlines');
          const data = (await res.json()) as { items?: { title: string }[] };
          const headlines = (data.items ?? []).slice(0, 8).map((h) => h.title);
          return {
            success: true,
            navigated_to: page,
            top_headlines: headlines,
            instruction:
              'The news page is now open. Briefly summarize these top headlines to the user in 2–3 concise sentences. Do not list them individually — give a fluid summary of what is happening in the world right now.',
          };
        } catch {
          return {
            success: true,
            navigated_to: page,
            instruction: 'The news page is open. Let the user know you have opened the news feed.',
          };
        }
      }

      return { success: true, navigated_to: page };
    },
  },
  {
    name: 'map_command',
    label: 'Map Control',
    description: 'Control the Jarvis map — fly to locations, add markers, draw glowing routes',
    tool: {
      type: 'function',
      name: 'map_command',
      description:
        'Open the Jarvis Map page and fly to / interact with any location. ' +
        'This is the ONLY function for ANYTHING map or location related. ALWAYS call this — never navigate_to_page or control_hud — when the user says things like: ' +
        '"navigate to X", "show me X", "go to X", "take me to X", "pull up X on the map", "where is X", "open the map", "fly to X", "zoom in on X", "find X", "search for X nearby". ' +
        'For any location request use command=fly_to with location set to the place name. ' +
        'Examples: "navigate to Tokyo" → fly_to, location="Tokyo". "show me Paris" → fly_to, location="Paris". ' +
        '"where am I?" → show_user_location. "route from Chicago to Detroit" → draw_route. "find coffee nearby" → search_nearby.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: [
              'fly_to',
              'fly_to_coordinates',
              'add_marker',
              'show_user_location',
              'draw_route',
              'clear_markers',
              'search_nearby',
            ],
            description:
              'fly_to: fly to a named location. ' +
              'fly_to_coordinates: fly to lat/lng. ' +
              'add_marker: pin a labeled marker. ' +
              'show_user_location: fly to and mark the user\'s GPS position. ' +
              'draw_route: draw a glowing driving route between two places. ' +
              'clear_markers: remove all markers and routes. ' +
              'search_nearby: search for a type of place near a location.',
          },
          location: {
            type: 'string',
            description: 'City, address, or place name (for fly_to and search_nearby).',
          },
          lat: { type: 'number', description: 'Latitude (for fly_to_coordinates and add_marker).' },
          lng: { type: 'number', description: 'Longitude (for fly_to_coordinates and add_marker).' },
          zoom: { type: 'number', description: 'Map zoom level 1–20 (optional, defaults to 13).' },
          label: { type: 'string', description: 'Marker label text (for add_marker).' },
          description: { type: 'string', description: 'Optional marker subtitle (for add_marker).' },
          start: { type: 'string', description: 'Route start location name (for draw_route).' },
          end: { type: 'string', description: 'Route end location name (for draw_route).' },
          query: { type: 'string', description: 'What to search for nearby, e.g. "coffee" (for search_nearby).' },
        },
        required: ['command'],
      },
    },
    handler: (args) => {
      const command = args.command as string;

      // Embed the map command in the navigate event so page.tsx can pass it as
      // a prop to MapPage — no setTimeout race condition.
      window.dispatchEvent(new CustomEvent('jarvis:navigate', {
        detail: { page: 'map', mapCommand: { type: command, ...args } },
      }));

      const desc: Record<string, string> = {
        fly_to: `Flying to "${args.location ?? ''}" on the map.`,
        fly_to_coordinates: `Flying to coordinates ${args.lat}, ${args.lng}.`,
        add_marker: `Marking "${args.label ?? ''}" on the map.`,
        show_user_location: 'Locating you on the map.',
        draw_route: `Drawing route from "${args.start ?? ''}" to "${args.end ?? ''}".`,
        clear_markers: 'Clearing all markers.',
        search_nearby: `Searching for "${args.query ?? ''}" near "${args.location ?? ''}".`,
      };

      return { success: true, message: desc[command] ?? `Map command "${command}" sent.` };
    },
  },
];

export function getFunctionByName(name: string): JarvisFunction | undefined {
  return FUNCTION_REGISTRY.find((f) => f.name === name);
}
