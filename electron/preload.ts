import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('centre', {
  request: (method: string, path: string, body?: unknown) => ipcRenderer.invoke('centre:request', method, path, body),
  chooseFiles: () => ipcRenderer.invoke('centre:choose-files'),
  openDiagram: (input:{id:string;theme:string}) => ipcRenderer.invoke('centre:open-diagram',input),
  openExternal: (url: string) => ipcRenderer.invoke('centre:open-external', url),
  saveFile: (file: { filename: string; content: string; mimeType: string }) => ipcRenderer.invoke('centre:save-file', file),
  printPaper: (paper: { title: string; latex: string; html?: string }) => ipcRenderer.invoke('centre:print-paper', paper),
  updates: {
    check: () => ipcRenderer.invoke('centre:updates:check'),
    install: () => ipcRenderer.invoke('centre:updates:install'),
    status: () => ipcRenderer.invoke('centre:updates:status'),
    configure: (settings: { token: string }) => ipcRenderer.invoke('centre:updates:configure', settings),
  },
});
