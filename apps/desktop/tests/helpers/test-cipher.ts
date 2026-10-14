// The unlocked vault's DocumentCipher for suites that need an encrypted store without a vault: the real
// AES-256-GCM file functions under a random key. The ciphertext differs from the plaintext, so a reader that
// skips decryption reads garbage and fails (CONTRIBUTING: "A fake cipher must change the bytes"), and a swapped
// encrypt/decrypt fails the GCM tag. Seven suites used to carry their own copy.
import { randomBytes } from 'node:crypto'
import { decryptFileAsync, encryptFileAsync, type DocumentCipher } from '../../src/main/services/workspace-vault'

/** A cipher equivalent to the unlocked vault's (`WorkspaceController.documentCipher()`), with a fresh random key. */
export function testCipher(): DocumentCipher {
  const key = randomBytes(32)
  return {
    encryptFileAsync: (src, dest) => encryptFileAsync(src, dest, key),
    decryptFileAsync: (src, dest) => decryptFileAsync(src, dest, key)
  }
}

export interface RecordingCipher {
  /** A `testCipher()` that records its decrypt calls. */
  cipher: DocumentCipher
  /** The destination path of every `decryptFileAsync` call, in call order. */
  asyncDecrypts: string[]
}

export interface RecordingCipherOptions {
  /** Awaited at the start of every `decryptFileAsync`, before it decrypts (e.g. a macrotask hop that makes two
   *  concurrent reads interleave). */
  beforeDecryptAsync?: () => Promise<void>
}

/** A real-AES cipher that records where each reader decrypted to. */
export function recordingCipher(o: RecordingCipherOptions = {}): RecordingCipher {
  const inner = testCipher()
  const rec: RecordingCipher = {
    asyncDecrypts: [],
    cipher: {
      encryptFileAsync: inner.encryptFileAsync,
      decryptFileAsync: async (src, dest) => {
        rec.asyncDecrypts.push(dest)
        if (o.beforeDecryptAsync) await o.beforeDecryptAsync()
        await inner.decryptFileAsync(src, dest)
      }
    }
  }
  return rec
}
