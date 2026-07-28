import type { Trade } from "@clarity-btc/shared";

export interface SenateIngestResult {
  newFilingIds: string[];
  trades: Trade[];
}

/**
 * Pipeline step 2: Senate eFD CSRF handshake -> JSON search for new filings ->
 * parse the HTML filing tables (~93% parse clean).
 *
 * TODO(ingest ticket): implement per the free-ingestion path (research ticket 09).
 */
export async function ingestSenate(): Promise<SenateIngestResult> {
  return { newFilingIds: [], trades: [] };
}
