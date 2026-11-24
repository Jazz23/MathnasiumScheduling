// A small HTML rewriter for the Radius and Sling proxies, which need to
// rewrite URL attributes and add a script at the top of <head>. It works on
// the whole page as text, tag by tag, and leaves everything else exactly as
// it was: the contents of <script>, <style>, <textarea> and comments are
// skipped, and only the attributes asked for are touched.

export interface AttributeRule {
  /** A tag name, or "*" for any tag. */
  tag: string;
  attribute: string;
  /** The new value, given the current one (as written in the HTML, entities and all). */
  map: (value: string) => string;
}

export interface RewriteOptions {
  /** HTML inserted right after the opening <head> tag. */
  headPrepend?: string;
  attributes: AttributeRule[];
}

// A comment, a raw-text element (whose contents aren't markup), or a start tag.
const TOKEN = /<!--[\s\S]*?-->|<(script|style|textarea)\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1\s*>|<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
const ATTRIBUTE = /(\s)([^\s"'>/=]+)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function rewriteAttributes(tag: string, attrs: string, rules: AttributeRule[]): string {
  const applicable = rules.filter((r) => r.tag === "*" || r.tag === tag);
  if (applicable.length === 0) return attrs;
  return attrs.replace(ATTRIBUTE, (whole, space: string, name: string, assignment, dq, sq, bare) => {
    if (assignment === undefined) return whole;
    const rule = applicable.find((r) => r.attribute === name.toLowerCase());
    const value: string | undefined = dq ?? sq ?? bare;
    if (!rule || !value) return whole;
    const quote = sq !== undefined ? "'" : '"';
    return `${space}${name}=${quote}${rule.map(value)}${quote}`;
  });
}

export function rewriteHtml(html: string, options: RewriteOptions): string {
  let headDone = !options.headPrepend;
  return html.replace(TOKEN, (whole, rawTag: string | undefined, rawAttrs: string | undefined, _rawBody: string | undefined, tag: string | undefined, attrs: string | undefined) => {
    if (rawTag !== undefined) {
      const opening = `<${rawTag}${rawAttrs ?? ""}>`;
      const rest = whole.slice(opening.length); // the contents and closing tag, untouched
      return `<${rawTag}${rewriteAttributes(rawTag.toLowerCase(), rawAttrs ?? "", options.attributes)}>${rest}`;
    }
    if (tag === undefined) return whole; // a comment
    const name = tag.toLowerCase();
    const rewritten = `<${tag}${rewriteAttributes(name, attrs ?? "", options.attributes)}>`;
    if (!headDone && name === "head") {
      headDone = true;
      return rewritten + options.headPrepend;
    }
    return rewritten;
  });
}
