type Evaluate = (source: string) => Promise<any>;

export async function viewReviewFiles(js: Evaluate, wait: (source: string) => Promise<void>) {
  await wait('document.querySelector("[data-action=approve-review]") !== null');
  await js('document.querySelectorAll("[data-action=view-file]").forEach(input => { if (!input.checked) input.click(); })');
}
