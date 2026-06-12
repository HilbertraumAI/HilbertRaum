// Chat screen building blocks (guidelines §3). ChatScreen.tsx composes these;
// each piece is renderer-only and theme-agnostic (role tokens via CSS).

export { ConversationList, groupConversations, type ConversationGroup } from './ConversationList'
export { Transcript, AssistantMarkdown } from './Transcript'
export { MessageActions } from './MessageActions'
export { Composer } from './Composer'
export { DictationButton, DICTATION_NO_SPEECH_MESSAGE } from './DictationButton'
export { SourcesDisclosure } from './SourcesDisclosure'
export { DepthMenu, DEPTH_LABELS } from './DepthMenu'
export { ScopePopover } from './ScopePopover'
