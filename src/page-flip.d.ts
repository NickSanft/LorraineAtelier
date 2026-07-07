// Minimal ambient types for StPageFlip (the `page-flip` package ships no .d.ts).
// We import the ESM build directly because the package's "main" is the UMD bundle.
declare module "page-flip/dist/js/page-flip.module.js" {
  export interface PageFlipEvent {
    data: number;
    object: unknown;
  }
  export class PageFlip {
    constructor(element: HTMLElement, settings: Record<string, unknown>);
    loadFromHTML(items: NodeListOf<Element> | HTMLElement[]): void;
    updateFromHtml(items: NodeListOf<Element> | HTMLElement[]): void;
    flipNext(corner?: "top" | "bottom"): void;
    flipPrev(corner?: "top" | "bottom"): void;
    flip(page: number, corner?: "top" | "bottom"): void;
    turnToNextPage(): void;
    turnToPrevPage(): void;
    getCurrentPageIndex(): number;
    getPageCount(): number;
    on(event: string, callback: (e: PageFlipEvent) => void): void;
    destroy(): void;
  }
}
