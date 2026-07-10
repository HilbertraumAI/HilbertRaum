// Images screen building blocks (image-understanding §11). ImagesScreen.tsx composes these;
// each piece is renderer-only and theme-agnostic (role tokens via CSS). Mirrors renderer/chat/.

export { ImageDropZone } from './ImageDropZone'
export { ImagePreview } from './ImagePreview'
export { QuestionComposer, type ComposerChip } from './QuestionComposer'
export { AnswerThread, __turnRowRenderCounts, type ImageTurn } from './AnswerThread'
export { ImageHistory } from './ImageHistory'
export { VisionUnavailable } from './VisionUnavailable'
export {
  decodeImage,
  imageMimeFromName,
  imageMimeOfFile,
  ImageDecodeError,
  MAX_IMAGE_BYTES,
  type DecodedImage,
  type DecodeImage,
  type ImageMime
} from './decode'
