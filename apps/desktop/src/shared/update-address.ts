// The address the app names for updates (app-update plan G-17, O15): the owner's page that answers
// `<address>/from/<running version>` for every version, for years. The copy shows it as `{address}`: X01
// (`main.workspace.newer`) and C01 (`main.workspace.schemaUnreadable`), where main (`registerWorkspaceIpc.ts`) and the
// gate (`WorkspaceGate.tsx`) fill it through `workspaceFailureParams` (`workspace-failure-keys.ts`); later F-2's
// refusals, F-21 and the support notices (P4, P6, P7). Every reader imports this constant and never writes the address
// again: `repo-hygiene.test.ts` finds it written once under src/.
//
// PURE (no node:, no electron, no I/O), so main, preload and renderer can import it.
//
// A PLACEHOLDER until P11c types the real address (O15): a host on the reserved `.invalid` domain (RFC 2606), which can
// never resolve. `repo-hygiene.test.ts` fails once apps/desktop/package.json's version leaves 0.1.66 (release 1's
// version bump) while this is still the placeholder.
export const UPDATE_ADDRESS = 'https://update-address.invalid'
