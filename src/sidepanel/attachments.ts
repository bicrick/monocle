export interface PendingImage {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  dataBase64: string;
}

function mimeToName(mime: string, index: number): string {
  const ext =
    mime === "image/png"
      ? "png"
      : mime === "image/webp"
        ? "webp"
        : mime === "image/gif"
          ? "gif"
          : "jpg";
  return `paste-${index + 1}.${ext}`;
}

async function fileToPending(file: File, index: number): Promise<PendingImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  const dataBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return {
    id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: file.name || mimeToName(file.type || "image/png", index),
    mimeType: file.type || "image/png",
    dataUrl,
    dataBase64,
  };
}

export interface AttachmentTray {
  getImages: () => PendingImage[];
  clear: () => void;
  count: () => number;
  addFiles: (files: File[]) => Promise<void>;
}

/** Quiet thumbnail strip for pasted images in the composer. */
export function createAttachmentTray(host: HTMLElement): AttachmentTray {
  const tray = document.createElement("div");
  tray.className = "attach-tray";
  tray.hidden = true;
  host.prepend(tray);

  const items: PendingImage[] = [];

  function render(): void {
    tray.hidden = items.length === 0;
    tray.replaceChildren();
    for (const img of items) {
      const chip = document.createElement("div");
      chip.className = "attach-chip";
      const thumb = document.createElement("img");
      thumb.src = img.dataUrl;
      thumb.alt = img.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "attach-remove";
      remove.title = "Remove";
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        const idx = items.findIndex((x) => x.id === img.id);
        if (idx >= 0) items.splice(idx, 1);
        render();
      });
      chip.append(thumb, remove);
      tray.append(chip);
    }
  }

  async function addFiles(files: File[]): Promise<void> {
    const images = files.filter((f) => f.type.startsWith("image/")).slice(0, 5);
    for (let i = 0; i < images.length; i++) {
      if (items.length >= 5) break;
      items.push(await fileToPending(images[i], items.length));
    }
    render();
  }

  return {
    getImages: () => items.slice(),
    clear() {
      items.length = 0;
      render();
    },
    count: () => items.length,
    addFiles,
  };
}

export async function collectPasteImages(
  event: ClipboardEvent,
): Promise<File[]> {
  const files: File[] = [];
  const items = event.clipboardData?.items;
  if (!items) return files;
  for (const item of Array.from(items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}
