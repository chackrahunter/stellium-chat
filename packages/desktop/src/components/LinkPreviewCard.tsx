import type { LinkPreview } from '@stellium/shared';

/** Kompakte Vorschau zu einem Link — Titel, Text, Bild. */
export function LinkPreviewCard({ preview }: { preview: LinkPreview }) {
  const open = () => {
    if (window.stellium) void window.stellium.openExternal(preview.url);
    else window.open(preview.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <button className="link-card" onClick={open} title={preview.url}>
      {preview.image && (
        <img className="link-card__image" src={preview.image} alt="" loading="lazy" />
      )}
      <div className="link-card__body">
        {preview.site && <div className="link-card__site">{preview.site}</div>}
        {preview.title && <div className="link-card__title">{preview.title}</div>}
        {preview.description && <div className="link-card__desc">{preview.description}</div>}
      </div>
    </button>
  );
}
