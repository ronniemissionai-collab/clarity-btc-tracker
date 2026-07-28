import type { Bill } from "@clarity-btc/shared";

/**
 * Pipeline step 6: refresh CLARITY Act (H.R. 3633, 119th) status from keyless
 * sources: GovInfo BILLSTATUS XML, House Clerk roll XML
 * (https://clerk.house.gov/evs/{year}/roll{NNN}.xml), and the Senate vote menu
 * (vote_menu_119_2.xml). Must handle substitute/re-passage logic: the Senate
 * text is a strike-and-replace ANS - "passed Senate" never means the
 * House-passed text became law. Cloture is not passage.
 *
 * TODO(bill ticket): implement per the CLARITY status Answer (research ticket 02).
 */
export async function refreshBill(): Promise<Bill | null> {
  return null;
}
