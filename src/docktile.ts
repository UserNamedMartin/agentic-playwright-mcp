// A per-profile Dock icon: the browser's own icon with a short label (up to 3
// characters) in a colored tag at the top right, so several agent browsers can
// be told apart in the Dock. Chrome sets it through the (experimental) CDP
// method Browser.setDockTile; the image is drawn with OffscreenCanvas in the
// companion extension's service worker, so no image library is needed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Worker } from 'playwright-core';

export const defaultBadgeColors = ['#d93025', '#1a73e8', '#188038', '#e37400', '#9334e6', '#007b83'];

export function validateBadge(label: string) {
  if ([...label].length > 3)
    throw new Error('A badge has at most 3 characters.');
}

// The browser's own icon as PNG (macOS app bundles only), cached per profile.
export function baseIcon(executablePath: string, cacheFile: string): string | undefined {
  if (process.platform !== 'darwin')
    return undefined;
  const bundle = executablePath.match(/^(.*\.app)\/Contents\/MacOS\//)?.[1];
  if (!bundle)
    return undefined;
  try {
    if (!fs.existsSync(cacheFile)) {
      const plist = path.join(bundle, 'Contents', 'Info.plist');
      let iconName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', plist], { encoding: 'utf8' }).trim();
      if (!iconName.endsWith('.icns'))
        iconName += '.icns';
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      execFileSync('sips', ['-s', 'format', 'png', '-Z', '512', path.join(bundle, 'Contents', 'Resources', iconName), '--out', cacheFile], { stdio: 'pipe' });
    }
    return fs.readFileSync(cacheFile).toString('base64');
  } catch {
    return undefined;
  }
}

// Draws the icon with the label tag; returns base64 PNG.
export async function renderDockIcon(worker: Worker, icon: string, label: string, color: string): Promise<string> {
  return await worker.evaluate(async ([icon, label, color]) => {
    const size = 512;
    const bytes = Uint8Array.from(atob(icon), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(size, size);
    const g = canvas.getContext('2d')!;
    g.drawImage(bitmap, 0, 0, size, size);
    // Tag: top right, about half the icon wide.
    const w = size * 0.52, h = size * 0.3, x = size - w - size * 0.01, y = size * 0.03, r = h * 0.3;
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = size * 0.018;
    g.strokeStyle = '#ffffff';
    g.stroke();
    let fontSize = h * 0.7;
    const font = (px: number) => `700 ${px}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
    g.font = font(fontSize);
    while (g.measureText(label).width > w * 0.84 && fontSize > 10) {
      fontSize -= 2;
      g.font = font(fontSize);
    }
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, x + w / 2, y + h / 2 + fontSize * 0.04);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 0x8000)
      binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    return btoa(binary);
  }, [icon, label, color] as const);
}
