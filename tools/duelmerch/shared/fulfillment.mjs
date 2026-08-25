// Which supplier fulfils orders.
//
// Duel already has designs and a supplier of their own — if this storefront is
// ever pointed at them, write shared/providers/<them>.mjs exporting the same
// five functions and swap the import below. The API routes, cart, checkout,
// payment handling and privacy model all stay exactly as they are.
export * as provider from "./providers/printful.mjs";
