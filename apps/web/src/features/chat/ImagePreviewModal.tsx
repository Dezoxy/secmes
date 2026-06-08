import { useEffect } from 'react';
import { X, Download, ZoomIn, ZoomOut } from 'lucide-react';
import { IconButton, Modal } from '../ui';

interface ImagePreviewModalProps {
  imageUrl: string | null;
  onClose: () => void;
}

export function ImagePreviewModal({ imageUrl, onClose }: ImagePreviewModalProps) {
  useEffect(() => {
    if (imageUrl) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [imageUrl]);

  if (!imageUrl) return null;

  return (
    <Modal
      ariaLabel="Image preview"
      onClose={onClose}
      className="items-center justify-center bg-black/90 backdrop-blur-sm transition-opacity duration-200"
      contentClassName="relative flex h-full w-full items-center justify-center"
    >
      <div className="absolute inset-0" onClick={onClose} />
      <IconButton
        onClick={onClose}
        size="lg"
        className="absolute right-4 top-4 z-10 rounded-xl bg-white/10 text-white/80 hover:bg-white/20 hover:text-white"
        aria-label="Close image preview"
      >
        <X className="w-6 h-6" />
      </IconButton>

      <div className="absolute top-4 left-4 flex gap-2 z-10">
        <IconButton
          size="md"
          className="rounded-xl bg-white/10 text-white/80 hover:bg-white/20 hover:text-white"
          aria-label="Zoom in"
        >
          <ZoomIn className="w-5 h-5" />
        </IconButton>
        <IconButton
          size="md"
          className="rounded-xl bg-white/10 text-white/80 hover:bg-white/20 hover:text-white"
          aria-label="Zoom out"
        >
          <ZoomOut className="w-5 h-5" />
        </IconButton>
        <IconButton
          size="md"
          className="rounded-xl bg-white/10 text-white/80 hover:bg-white/20 hover:text-white"
          aria-label="Download image"
        >
          <Download className="w-5 h-5" />
        </IconButton>
      </div>

      <div className="relative max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <img
          src={imageUrl}
          alt="Preview"
          className="object-contain max-h-[90vh] max-w-[90vw] rounded-lg"
        />
      </div>
    </Modal>
  );
}
