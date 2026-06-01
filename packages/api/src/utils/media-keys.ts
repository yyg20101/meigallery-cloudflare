const GALLERY_MEDIA_EXTENSIONS = '(?:jpe?g|png|webp|gif)'

export function isExpectedGalleryMediaKey(r2Key: string, galleryId: string, assetId: string): boolean {
  return new RegExp(`^originals/${escapeRegExp(galleryId)}/${escapeRegExp(assetId)}\\.${GALLERY_MEDIA_EXTENSIONS}$`, 'i').test(r2Key)
}

export function isExpectedGalleryCoverKey(r2Key: string, galleryId: string): boolean {
  const escapedGalleryId = escapeRegExp(galleryId)
  const directCoverPattern = `covers/${escapedGalleryId}(?:/cover)?\\.${GALLERY_MEDIA_EXTENSIONS}`
  const galleryOriginalPattern = `originals/${escapedGalleryId}/[^/]+\\.${GALLERY_MEDIA_EXTENSIONS}`
  return new RegExp(`^(?:${directCoverPattern}|${galleryOriginalPattern})$`, 'i').test(r2Key)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
