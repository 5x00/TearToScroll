const sl = "user-select:text;";
const ff = "font-family:'Urbanist',system-ui,sans-serif;";

// Image sequence — served from public/imgs/0001.jpg … 0144.jpg.
export const IMGS: string[] = Array.from(
  { length: 332 },
  (_, i) => `/imgs/${String(i + 1).padStart(4, "0")}.jpg`,
);
const IMG_FPS = 24;

// CSS custom properties drive the light/dark theme across all pages.
function applyTheme(dark: boolean): void {
  const r = document.documentElement.style;
  r.setProperty("--ct", dark ? "#F2F1ED" : "#1A1916");
  r.setProperty("--cm", dark ? "rgba(242,241,237,0.4)" : "rgba(20,20,16,0.4)");
  r.setProperty("--cbg", dark ? "#0F0E0C" : "#F2F1ED");
  r.setProperty("--csu", dark ? "#1E1D1A" : "#E0DFD9");
  r.setProperty(
    "--ctoggle-off",
    dark ? "rgba(242,241,237,0.15)" : "rgba(20,20,16,0.15)",
  );
  r.setProperty("--ctoggle-thumb", dark ? "#0F0E0C" : "#ffffff");
}
applyTheme(false);

function nav(): string {
  return `<div style="position:absolute;top:0;left:0;right:0;padding:22px 32px;display:flex;justify-content:space-between;align-items:center;">
    <div style="${ff}font-size:13px;font-weight:600;letter-spacing:0.06em;color:var(--ct);${sl}">day-dream</div>
    <div style="display:flex;gap:28px;">
      <span style="${ff}font-size:10px;font-weight:500;letter-spacing:0.14em;color:var(--cm);${sl}">WORK</span>
      <span style="${ff}font-size:10px;font-weight:500;letter-spacing:0.14em;color:var(--cm);${sl}">ABOUT</span>
      <span style="${ff}font-size:10px;font-weight:500;letter-spacing:0.14em;color:var(--cm);${sl}">CONTACT</span>
    </div>
  </div>`;
}

export function setupPage0(div: HTMLElement): void {
  div.style.background = "var(--cbg)";
  div.innerHTML = `
    <div style="position:absolute;inset:0;">
      <div style="position:absolute;top:96px;left:16px;right:16px;bottom:96px;background:var(--csu);overflow:hidden;border-radius:8px;">
        <img src="/bg.jpg" style="width:100%;height:100%;object-fit:cover;display:block;" onerror="this.style.display='none'"/>
      </div>
      <div style="position:absolute;top:0;left:0;right:0;height:96px;display:flex;align-items:center;justify-content:center;">
        <span style="${ff}font-size:14px;font-weight:400;letter-spacing:0.22em;color:var(--ct);${sl}">day-dream</span>
      </div>
      <div style="position:absolute;bottom:0;left:0;right:0;height:96px;display:flex;align-items:center;justify-content:center;">
        <p style="font-family:'Manrope',sans-serif;font-size:12px;font-weight:400;letter-spacing:0.05em;color:var(--ct);line-height:1.9;margin:0;text-align:center;${sl}">future-forward studio helping brands<br>harness emerging tech for maximum creative impact</p>
      </div>
    </div>
  `;
}

export function setupPage1(
  div: HTMLElement,
  repaint?: () => void,
  uploadImage?: (img: HTMLImageElement) => void,
): void {
  div.style.background = "var(--cbg)";
  div.innerHTML = `
    <style>
      .p1-chk { display: none; }
      .p1-sw {
        display: inline-block; width: 108px; height: 56px;
        background: var(--ctoggle-off); border-radius: 56px;
        position: relative; cursor: pointer; transition: background 0.25s;
        flex-shrink: 0;
      }
      .p1-sw::after {
        content: ''; position: absolute; top: 6px; left: 6px;
        width: 44px; height: 44px; border-radius: 50%;
        background: var(--ctoggle-thumb); transition: transform 0.25s;
        box-shadow: 0 1px 4px rgba(0,0,0,0.18);
      }
      .p1-chk:checked + .p1-sw { background: var(--ct); }
      .p1-chk:checked + .p1-sw::after { transform: translateX(52px); }
    </style>
    ${nav()}
    <div style="position:absolute;bottom:24px;left:32px;display:flex;align-items:center;gap:20px;">
      <span style="${ff}font-size:10px;letter-spacing:0.12em;color:var(--cm);">DARK MODE</span>
      <div><input class="p1-chk" type="checkbox" id="p1-dark"><label class="p1-sw" for="p1-dark"></label></div>
    </div>
  `;

  // Image sequence — direct gl.texImage2D path (no texElementImage2D).
  // Preload all frames; gl.texImage2D reads decoded HTMLImageElement directly,
  // bypassing DOM rasterisation entirely so the cloth sim stays at full speed.
  const images: HTMLImageElement[] = IMGS.map((src) => {
    const img = new Image();
    img.src = src;
    return img;
  });

  let frameIdx = 0;
  let lastDisplayedIdx = -1;
  let lastFrameTime = -1;
  const frameDuration = 1000 / IMG_FPS;
  let seqRafId = 0;

  const advanceFrame = (ts: number) => {
    if (!div.isConnected) return;
    if (lastFrameTime < 0) lastFrameTime = ts;

    if (images.length > 0 && ts - lastFrameTime >= frameDuration) {
      const steps = Math.floor((ts - lastFrameTime) / frameDuration);
      frameIdx = (frameIdx + steps) % images.length;
      lastFrameTime += steps * frameDuration;

      if (frameIdx !== lastDisplayedIdx) {
        const img = images[frameIdx];
        if (img.complete && img.naturalWidth > 0) {
          uploadImage?.(img);
          lastDisplayedIdx = frameIdx;
        }
      }
    }
    seqRafId = requestAnimationFrame(advanceFrame);
  };

  seqRafId = requestAnimationFrame(advanceFrame);

  // Dark mode toggle.
  const darkChk = div.querySelector("#p1-dark") as HTMLInputElement;
  darkChk.addEventListener("change", () => {
    applyTheme(darkChk.checked);
    window.dispatchEvent(new CustomEvent("clothrepaintall"));
    repaint?.();
  });

  // Self-cleanup when unmounted.
  const onMove = () => {
    if (!div.isConnected) {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(seqRafId);
    }
  };
  window.addEventListener("pointermove", onMove);
}

export function setupPage2(div: HTMLElement): void {
  div.style.background = "var(--cbg)";
  const dot = `<span style="margin:0 14px;color:var(--cm);">·</span>`;

  const tiles = ["/work/1.jpg", "/work/2.jpg", "/work/3.jpg", "/work/4.jpg"];
  const tileHtml = tiles
    .map(
      (src) =>
        `<div style="background:var(--csu);overflow:hidden;border-radius:4px;">` +
        `<img src="${src}" style="width:100%;height:100%;object-fit:cover;display:block;" onerror="this.style.display='none'"/>` +
        `</div>`,
    )
    .join("");
  div.innerHTML = `
    ${nav()}
    <div style="position:absolute;top:78px;left:32px;">
      <span style="${ff}font-size:10px;font-weight:500;letter-spacing:0.14em;color:var(--cm);${sl}">ABOUT</span>
    </div>
    <div style="position:absolute;top:64px;left:32px;right:32px;bottom:48px;display:flex;gap:28px;align-items:center;">
      <div style="flex:1;display:flex;flex-direction:column;justify-content:center;">
        <div style="${ff}font-size:48px;font-weight:500;line-height:0.95;letter-spacing:-1.5px;color:var(--ct);${sl}">
          We make things<br>at the intersection<br>of art &amp; tech.
        </div>
        <div style="margin-top:32px;display:flex;align-items:center;flex-wrap:wrap;">
          <span style="${ff}font-size:11px;font-weight:400;letter-spacing:0.1em;color:var(--cm);${sl}">CG</span>${dot}
          <span style="${ff}font-size:11px;font-weight:400;letter-spacing:0.1em;color:var(--cm);${sl}">AI</span>${dot}
          <span style="${ff}font-size:11px;font-weight:400;letter-spacing:0.1em;color:var(--cm);${sl}">APPS</span>${dot}
          <span style="${ff}font-size:11px;font-weight:400;letter-spacing:0.1em;color:var(--cm);${sl}">WEB</span>
        </div>
      </div>
      <div style="flex:1.1;height:100%;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:8px;padding-top:28px;">
        ${tileHtml}
      </div>
    </div>
    <div style="position:absolute;bottom:24px;left:32px;right:32px;display:flex;justify-content:space-between;align-items:center;">
      <span style="${ff}font-size:10px;font-weight:400;letter-spacing:0.12em;color:var(--cm);${sl}">ACTIVE SINCE 2025</span>
      <span style="${ff}font-size:10px;font-weight:400;letter-spacing:0.12em;color:var(--cm);${sl}">↓ TEAR TO REVEAL</span>
    </div>
  `;
}

export const pageSetups: ReadonlyArray<
  (
    div: HTMLElement,
    repaint?: () => void,
    uploadImage?: (img: HTMLImageElement) => void,
  ) => void
> = [setupPage0, setupPage1, setupPage2];
