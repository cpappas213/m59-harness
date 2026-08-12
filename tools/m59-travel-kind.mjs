// A direct room boundary is ZONING, not a trip.
//
// The broker's `travel` primitive is used for both, so the distinction has to be made
// from its route/leg count rather than from the verb that happened to execute it. Keep
// this predicate shared: the live recorder, the short-lived dashboard rows, and the
// travel-safety experiment must not quietly use three different denominators.

export function routeTravelKind(route) {
  const hops = Array.isArray(route?.hops) ? route.hops.length : null;
  return route?.found && hops != null && hops <= 1 ? 'zoning' : 'travel';
}

export function recordedTravelKind(record = {}) {
  const legs = Number(record?.legs);
  // Old rows without a leg count cannot be proved to be zoning, so retain them. New and
  // current rows all carry `legs`; zero and one are not trips.
  return record?.legs != null && Number.isFinite(legs) && legs <= 1 ? 'zoning' : 'travel';
}

export const isTravelTrip = record => recordedTravelKind(record) === 'travel';
