export interface Extracted {
  text: string
  name: string
  pages?: number
}

export const ACCEPTED = '.pdf,.txt,.md,.docx'

/**
 * Client-side text extraction — file contents never leave the browser
 * except as plain text sent to the generation endpoint.
 */
export async function extractFile(file: File): Promise<Extracted> {
  const name = file.name
  const lower = name.toLowerCase()

  if (lower.endsWith('.pdf')) return extractPdf(file, name)
  if (lower.endsWith('.docx')) return extractDocx(file, name)
  if (lower.endsWith('.txt') || lower.endsWith('.md') || file.type.startsWith('text/')) {
    const text = await file.text()
    return { text, name }
  }
  throw new Error('Unsupported file type. Use PDF, DOCX, TXT or MD.')
}

async function extractPdf(file: File, name: string): Promise<Extracted> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
  const data = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data }).promise
  const parts: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    const line = tc.items
      .map((it: unknown) => (typeof (it as { str?: string }).str === 'string' ? (it as { str: string }).str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    parts.push(line)
  }
  return { text: parts.join('\n\n'), name, pages: doc.numPages }
}

async function extractDocx(file: File, name: string): Promise<Extracted> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
  return { text: result.value, name }
}

/** Split long text into paragraph-aligned chunks for sequential generation. */
export function chunkText(text: string, maxLen = 28_000): string[] {
  if (text.length <= maxLen) return [text]
  const paras = text.split(/\n{2,}/)
  const chunks: string[] = []
  let cur = ''
  for (const p of paras) {
    const piece = p.length > maxLen ? p.slice(0, maxLen) : p // hard cap pathological paragraphs
    if (cur && (cur + '\n\n' + piece).length > maxLen) {
      chunks.push(cur)
      cur = piece
    } else {
      cur = cur ? cur + '\n\n' + piece : piece
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}
