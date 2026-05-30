import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

/**
 * Root route. Shopify loads the embedded app at the App URL (this path "/"),
 * passing ?shop=&host=&embedded=1&id_token=… — forward those to the embedded
 * app at /app. Without this redirect the iframe renders an empty shell (blank
 * screen), because the App Bridge UI lives under /app.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // Non-embedded direct visit: send to the login / shop-entry page.
  throw redirect("/auth/login");
};
