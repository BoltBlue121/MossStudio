export function cloverUrl(file: string, seq?: number): string {
  return `clover://local?path=${encodeURIComponent(file)}${seq === undefined ? '' : `&seq=${seq}`}`
}
