// Ponto de entrada do cliente: store (dados) -> mundo (canvas) -> UI (painéis).
import { OfficeStore } from './net/store';
import { createWorld } from './world';
import { createUI } from './ui';
import { migrateLegacyKeys, safeLocalStorage } from './ui/prefs';
import { loadSharedStorage } from './net/server-storage';
import { startFotoPortal } from './net/foto-portal';

// Antes de tudo: o mundo (carteiras) e a UI (preferências) leem o localStorage ao serem criados.
migrateLegacyKeys(safeLocalStorage());

const params = new URLSearchParams(location.search);
const store = new OfficeStore({ mock: params.has('mock') });
// Vida social (carteiras, placares, barrinhas): do servidor, para valer em qualquer navegador.
const shared = params.has('mock') ? undefined : await loadSharedStorage();
const canvas = document.getElementById('world') as HTMLCanvasElement;
const world = createWorld(canvas, store, shared);
createUI(document.getElementById('ui') as HTMLElement, store, world);
store.connect();
if (!store.mock) startFotoPortal(canvas, store);

// Facilita a depuração pelo console do navegador.
Object.assign(window, { habblaud: { store, world } });
