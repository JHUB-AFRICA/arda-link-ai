/**
 * Skeleton — animated loading placeholder for the Choropleth's
 * map and panels. Three grey bars in a vertical stack.
 */
export function Skeleton() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="h-3 bg-gray-800 rounded w-3/4" />
      <div className="h-3 bg-gray-800 rounded w-2/3" />
      <div className="h-3 bg-gray-800 rounded w-1/2" />
    </div>
  );
}