// Chat screen building blocks (guidelines §3). ChatScreen.tsx composes these;
// each piece is renderer-only and theme-agnostic (role tokens via CSS).

export { ConversationList, groupConversations, type ConversationGroup } from './ConversationList'
export { Transcript, StreamAnnouncer } from './Transcript'
// AssistantMarkdown is the lazy wrapper (renderer code-split): the Streamdown/KaTeX weight loads
// as a separate async chunk, so importing it here never pulls that ~2 MB into the initial bundle.
export { AssistantMarkdown } from './AssistantMarkdownLazy'
export { MessageActions } from './MessageActions'
export { Composer } from './Composer'
export { DictationButton } from './DictationButton'
export { SourcesDisclosure } from './SourcesDisclosure'
export { DepthMenu, DEPTH_LABEL_KEYS } from './DepthMenu'
export { ScopePopover } from './ScopePopover'
export { ScopeNarrowDialog } from './ScopeNarrowDialog'
export { SkillPicker } from './SkillPicker'
export { SkillInfoCard } from './SkillInfoCard'
export { SkillRunBar, type SkillRunTarget } from './SkillRunBar'
export { ContextMeter } from './ContextMeter'
