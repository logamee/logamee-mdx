export const MAMMOTH_MESSAGE_POLICY_VERSION = 'mammoth@1.12.0' as const;

export interface DocxConversionMessage {
  type: 'error' | 'warning';
  message: string;
}

export interface DocxMessageClassification {
  fatal: boolean;
  detectedLoss: boolean;
}

const LOSS_WARNING_EXACT = new Set([
  'Could not find image file for a:blip element',
  'A v:imagedata element without a relationship ID was ignored',
  'unexpected non-row element in table, cell merging may be incorrect',
  'unexpected non-cell element in table row, cell merging may be incorrect',
]);

const LOSS_WARNING_PREFIXES = [
  'An unrecognised element was ignored: ',
  'A w:sym element with an unsupported character was ignored: ',
  'Unsupported break type: ',
] as const;

const IMAGE_LOSS_PREFIX = 'Image of type ';
const IMAGE_LOSS_SUFFIX = ' is unlikely to display in web browsers';
const FATAL_WARNING_PREFIX = 'Did not understand this style mapping, so ignored it: ';

function normalizeMessage(message: string): string {
  return message.replace(/\r\n?/g, '\n').trim();
}

function isConversionMessage(value: unknown): value is DocxConversionMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (record.type === 'error' || record.type === 'warning')
    && typeof record.message === 'string';
}

export function classifyDocxMessages(messages: readonly unknown[]): DocxMessageClassification {
  let fatal = false;
  let detectedLoss = false;

  for (const value of messages) {
    if (!isConversionMessage(value)) continue;
    if (value.type === 'error') {
      fatal = true;
      continue;
    }
    const message = normalizeMessage(value.message);
    if (message.startsWith(FATAL_WARNING_PREFIX)) {
      fatal = true;
      continue;
    }
    if (
      LOSS_WARNING_EXACT.has(message)
      || LOSS_WARNING_PREFIXES.some((prefix) => message.startsWith(prefix))
      || (
        message.startsWith(IMAGE_LOSS_PREFIX)
        && message.endsWith(IMAGE_LOSS_SUFFIX)
        && message.length > IMAGE_LOSS_PREFIX.length + IMAGE_LOSS_SUFFIX.length
      )
    ) {
      detectedLoss = true;
    }
  }

  return { fatal, detectedLoss };
}
