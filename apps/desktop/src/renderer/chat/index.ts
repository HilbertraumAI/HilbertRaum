// Chat screen building blocks (guidelines §3). ChatScreen.tsx composes these;
// each piece is renderer-only and theme-agnostic (role tokens via CSS).

export { ConversationList, groupConversations, type ConversationGroup } from './ConversationList'
export { Transcript, AssistantMarkdown } from './Transcript'
export { MessageActions } from './MessageActions'
export { Composer } from './Composer'
export { DictationButton } from './DictationButton'
export { SourcesDisclosure } from './SourcesDisclosure'
export { DepthMenu, DEPTH_LABEL_KEYS } from './DepthMenu'
export { ScopePopover } from './ScopePopover'
