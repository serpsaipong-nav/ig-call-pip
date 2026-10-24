# Instagram Call PiP

Pops an Instagram video call into a small floating window that stays on top of every app, with mic, camera and hang-up buttons.

## Install in Arc (or Chrome, Edge, Brave)
1. Open `arc://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this `ig-call-pip` folder.

## Use
1. Start or join a video call on instagram.com.
2. Click the white **⧉ Pop out** button at the top right of the call, or press **Alt+P**.
3. Switch to any other app. The call window floats on top. You can drag and resize it.
4. In the floating window:
   - 🎤 mutes or unmutes your mic. Shortcut: **M**.
   - 📷 turns your camera off or on. Shortcut: **V**.
   - ⤢ changes the window size: extra small, small, medium, large. Shortcut: **S**. At the smaller sizes this button hides to save space; use **S** or double-click the corner grip instead.
   - Red ☎ ends the call.
   - A white button means it's off. A small red badge on your self-view means your mic is muted.
   - Her mic, at the top right: a red **Muted** pill when Instagram shows her as muted, or green bars while she's talking. Nothing shows while she's quiet.
   - Drag the small grip in the bottom-right corner to resize the window to any size. Double-click the grip to step through the preset sizes.
   - Arc won't let the floating window get narrower than its title bar needs. The first time you hit that limit, the window shows "Smallest Arc allows". From then on the smallest preset becomes a short, wide strip, which is as small as Arc allows.
   - Drag your self-view to any corner.
   - The controls fade out when you're not moving the mouse. Move the mouse over the window to bring them back.
   - The window size and self-view corner are remembered for your next call.
5. To bring the video back into the tab, close the floating window or click **Bring back**.

Keep the call tab open. It can sit in the background, but closing it ends the call.

## How it works
- `mic-hook.js` runs before Instagram loads and keeps a reference to your camera and mic streams.
- `content.js` spots the call, moves the video elements into a Document Picture-in-Picture window, and puts them back when the window closes.
- The mic and camera buttons press Instagram's own buttons, so Instagram stays in sync. If those buttons can't be found, the extension switches your mic and camera tracks off directly. She still stops hearing or seeing you, but Instagram's own icons won't change.
- If the browser doesn't support Document PiP, it uses the normal video PiP instead, which has built-in mic, camera and hang-up buttons.

## If a button doesn't respond
Instagram may have renamed its buttons. Right-click Instagram's mute button, choose **Inspect**, and copy its `aria-label`. Then update `PATTERNS` at the top of `content.js` and click reload on the extension.

## Testing without a real call
Serve this folder (`python3 -m http.server`) and open `/test/test.html`. That page fakes a call with canvas video.

To try the floating window and its controls without real picture-in-picture support, open `/test/test.html?simulate=1`. Add `&minw=280` to pretend the browser has a minimum window width.

## Credits
Icons are from [Lucide](https://lucide.dev), used under the ISC licence. Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Not affiliated with Instagram or Meta.
