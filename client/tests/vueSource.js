/******************************************************************/
/*  vueSource : the parts of a .vue file the source-reading      */
/*  tests look at (its template, its scripts), found by plain     */
/*  searches. A comment is cut out from its opening to its        */
/*  closing mark, never by one pattern replaced once : what the   */
/*  tests read is then exactly what the page shows.               */
/******************************************************************/

/**
 * A text without its comments of the given marks, each cut out from its opening to its closing
 * mark ; an unclosed one runs to the end.
 *
 * Args:
 *   text (string): the text.
 *   open (string): the opening mark ('<!--' by default).
 *   close (string): the closing mark ('-->' by default).
 *
 * Returns:
 *   string: the text without them.
 */
export function withoutComments(text, open = '<!--', close = '-->') {
  let out = '';
  let at = 0;
  for (;;) {
    const start = text.indexOf(open, at);
    if (start < 0) return out + text.slice(at);
    out += text.slice(at, start);
    const end = text.indexOf(close, start + open.length);
    if (end < 0) return out;
    at = end + close.length;
  }
}

/**
 * The contents of every block of a tag in a .vue file, in their order : what lies between each
 * opening tag (its attributes passed over) and its closing tag, whatever the case of the tag.
 *
 * Args:
 *   text (string): the file.
 *   tag (string): the tag, as 'script'.
 *
 * Returns:
 *   string[]: the contents of its blocks.
 */
export function blocksOf(text, tag) {
  const lower = text.toLowerCase();
  const opening = `<${tag.toLowerCase()}`;
  const closing = `</${tag.toLowerCase()}>`;
  const blocks = [];
  let at = 0;
  for (;;) {
    const start = lower.indexOf(opening, at);
    if (start < 0) return blocks;
    const body = lower.indexOf('>', start);
    if (body < 0) return blocks;
    const end = lower.indexOf(closing, body);
    if (end < 0) return blocks;
    blocks.push(text.slice(body + 1, end));
    at = end + closing.length;
  }
}
