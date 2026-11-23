// "Foto do meu escritório": com a aba visível, manda ao portal que hospeda o escritório uma foto pequena do canvas
// (20 s depois de abrir e a cada 5 min). O portal sai da origem de meta.links.bug (HABBLAUD_BUG_URL); sem ele, nada.
// O POST image/* pede preflight CORS: um site que não aceita a foto nunca recebe a imagem.
import type { OfficeStore } from './store';

export const FOTO_MAX_W = 1280;
export const FOTO_MAX_BYTES = 400_000;

/** https://portal/qualquer-coisa -> https://portal/api/escritorio/foto; ausente, inválido ou http = undefined. */
export function fotoUrl(bug: string | undefined): string | undefined {
  if (!bug) return undefined;
  try {
    const u = new URL(bug);
    return u.protocol === 'https:' ? `${u.origin}/api/escritorio/foto` : undefined;
  } catch {
    return undefined;
  }
}

/** Reduz para no máximo FOTO_MAX_W de largura, mantendo a proporção (nunca aumenta). */
export function fotoSize(w: number, h: number): { w: number; h: number } {
  const k = Math.min(1, FOTO_MAX_W / w);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

const toBlob = (c: HTMLCanvasElement, type: string) => new Promise<Blob | null>((r) => c.toBlob(r, type, 0.75));

export function startFotoPortal(canvas: HTMLCanvasElement, store: OfficeStore): void {
  const shot = async () => {
    const url = fotoUrl(store.snapshot?.meta.links?.bug);
    if (!url || document.visibilityState !== 'visible' || !canvas.width || !canvas.height) return;
    const { w, h } = fotoSize(canvas.width, canvas.height);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(canvas, 0, 0, w, h);
    // Safari não gera webp (devolve png): cai para jpeg
    let blob = await toBlob(c, 'image/webp');
    if (blob?.type !== 'image/webp') blob = await toBlob(c, 'image/jpeg');
    if (!blob || blob.type !== 'image/jpeg' && blob.type !== 'image/webp' || blob.size > FOTO_MAX_BYTES) return;
    await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': blob.type }, body: blob });
  };
  const run = () => void shot().catch(() => {}); // foto é enfeite: falha (rede, 429, canvas sujo) fica calada
  setTimeout(run, 20_000);
  setInterval(run, 5 * 60_000);
}
