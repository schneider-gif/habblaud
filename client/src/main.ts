// Ponto de entrada do cliente: store (dados) -> mundo (canvas) -> UI (painéis).
import { OfficeStore } from './net/store';
import { createWorld } from './world';
import { createUI } from './ui';
import { migrateLegacyKeys, safeLocalStorage } from './ui/prefs';
import { loadSharedStorage } from './net/server-storage';

// Antes de tudo: o mundo (carteiras) e a UI (preferências) leem o localStorage ao serem criados.
migrateLegacyKeys(safeLocalStorage());

const params = new URLSearchParams(location.search);
const store = new OfficeStore({ mock: params.has('mock') });
// Vida social (carteiras, placares, barrinhas): do servidor, para valer em qualquer navegador.
const shared = params.has('mock') ? undefined : await loadSharedStorage();
const world = createWorld(document.getElementById('world') as HTMLCanvasElement, store, shared);
createUI(document.getElementById('ui') as HTMLElement, store, world);
store.connect();

// Facilita a depuração pelo console do navegador.
Object.assign(window, { habblaud: { store, world } });
