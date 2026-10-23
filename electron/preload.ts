import { contextBridge, ipcRenderer } from 'electron';
import { desktopActionRequestSchema, type DesktopActionRequest } from '../shared/desktop-actions';
import { unwrapDesktopResponse } from '../shared/desktop-response';
import { nativeSaveResultSchema, type NativeSaveResult } from './save-result';

let nativeTitlebar = process.platform === 'darwin';
function syncWindowChrome() {
  if (document.documentElement) document.documentElement.dataset.nativeTitlebar = String(nativeTitlebar);
}
window.addEventListener('DOMContentLoaded', syncWindowChrome);
ipcRenderer.on('centre:window-chrome', (_event, value: unknown) => {
  if (typeof value !== 'boolean') return;
  nativeTitlebar = value;
  syncWindowChrome();
});

contextBridge.exposeInMainWorld('centre', {
  copyText: (text: string) => ipcRenderer.invoke('centre:copy-text', text),
  launchers: {
    list: () => ipcRenderer.invoke('centre:launchers:list'),
    change: (action: string, operation: string) => ipcRenderer.invoke('centre:launchers:change', action, operation),
  },
  actions: {
    subscribe: (listener: (request: DesktopActionRequest) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const request = desktopActionRequestSchema.safeParse(value);
        if (request.success) listener(request.data);
      };
      ipcRenderer.on('centre:actions:request', receive);
      return () => { ipcRenderer.removeListener('centre:actions:request', receive); };
    },
    ready: (): Promise<void> => ipcRenderer.invoke('centre:actions:ready'),
    acknowledge: (id: string): Promise<void> => ipcRenderer.invoke('centre:actions:acknowledge', id),
  },
  request: async (method: string, path: string, body?: unknown) => unwrapDesktopResponse(await ipcRenderer.invoke('centre:request', method, path, body)),
  chooseFiles: () => ipcRenderer.invoke('centre:choose-files'),
  openDiagram: (input:{id:string;theme:string}) => ipcRenderer.invoke('centre:open-diagram',input),
  openExternal: (url: string) => ipcRenderer.invoke('centre:open-external', url),
  saveFile: async (file: { filename: string; content: string; mimeType: string }): Promise<NativeSaveResult> => nativeSaveResultSchema.parse(await ipcRenderer.invoke('centre:save-file', file)),
  printPaper: async (paper: { title: string; latex: string; html?: string }): Promise<NativeSaveResult> => nativeSaveResultSchema.parse(await ipcRenderer.invoke('centre:print-paper', paper)),
  updates: {
    check: () => ipcRenderer.invoke('centre:updates:check'),
    install: () => ipcRenderer.invoke('centre:updates:install'),
    status: () => ipcRenderer.invoke('centre:updates:status'),
    configure: (settings: { token: string }) => ipcRenderer.invoke('centre:updates:configure', settings),
  },
});
