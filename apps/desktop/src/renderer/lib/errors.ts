// Electron wraps an error thrown by an ipcMain.handle handler as
// "Error invoking remote method 'channel': Error: <the real message>" before it
// reaches the renderer. Our main-process messages are already friendly (spec §11.4) —
// strip the transport prefix so users see only the message itself.
export function friendlyIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}
