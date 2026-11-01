export type DistributorEvent = {
  type: string;
  payload: Record<string, string | number>;
};
export function decodeDistributorEvents(
  logs: string[] | null | undefined,
  programId: string,
): DistributorEvent[];
