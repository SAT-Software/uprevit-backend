export const DOCUMENTATION_VIDEOS = {
	"department.departments-tab": "videos/department/departments-tab.mp4",
	"getting-started.welcome-dashboard": "videos/getting-started/welcome-dashboard.mp4",
	"product.compliance-tab": "videos/product/compliance-tab.mp4",
	"product.label-components": "videos/product/label-components.mp4",
	"product.label-tags": "videos/product/label-tags.mp4",
	"product.product-information": "videos/product/product-information.mp4",
	"product.product-plan-review-overview": "videos/product/product-plan-review-overview.mp4",
	"product.product-specifications": "videos/product/product-specifications.mp4",
	"product.products-intro": "videos/product/products-intro.mp4",
	"product.symbols-graphics": "videos/product/symbols-graphics.mp4",
	"projects.projects-tab": "videos/projects/projects-tab.mp4",
	"reports-analytics.overview": "videos/reports-analytics/overview.mp4",
	"working-with-files.source-files-archive-bookmarks":
		"videos/working-with-files/source-files-archive-bookmarks.mp4",
} as const;

export type DocumentationVideoKey = keyof typeof DOCUMENTATION_VIDEOS;

export const isDocumentationVideoKey = (value: string): value is DocumentationVideoKey =>
	Object.hasOwn(DOCUMENTATION_VIDEOS, value);

export const getDocumentationVideoObjectKey = (
	videoKey: string,
): string | null => {
	if (!isDocumentationVideoKey(videoKey)) return null;
	return DOCUMENTATION_VIDEOS[videoKey];
};
