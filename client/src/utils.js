// Returns the lowercased file extension from a URL's pathname, or '' if there
// is none / the URL is invalid.
export function getExtension(url) {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf('.');
    return dot !== -1 ? path.slice(dot + 1).toLowerCase() : '';
  } catch {
    return '';
  }
}
