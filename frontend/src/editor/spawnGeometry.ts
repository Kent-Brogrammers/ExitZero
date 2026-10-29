import type { BuildingScenario, Point, SpawnZone } from "../types/simulation";

const EPS = 1e-7;
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
export function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function polygonContainsPoint(points: readonly Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function polygonArea(points: readonly Point[]) {
  return Math.abs(points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length]!;
    return sum + p.x * q.y - q.x * p.y;
  }, 0)) / 2;
}
export function zoneBoundary(zone: SpawnZone): Point[] {
  return zone.polygon?.boundary ?? [
    { x: zone.x, y: zone.y }, { x: zone.x + zone.width, y: zone.y },
    { x: zone.x + zone.width, y: zone.y + zone.height }, { x: zone.x, y: zone.y + zone.height },
  ];
}
export function zoneContainsPoint(zone: SpawnZone, p: Point) {
  return polygonContainsPoint(zoneBoundary(zone), p) && !(zone.polygon?.holes ?? []).some(h => polygonContainsPoint(h, p));
}
export function zoneContainsDisc(zone: SpawnZone, p: Point, radius: number) {
  return zoneContainsPoint(zone, p) && [zoneBoundary(zone), ...(zone.polygon?.holes ?? [])].every(ring => ring.every((a, i) => segmentDistance(p, a, ring[(i + 1) % ring.length]!) >= radius - EPS));
}
function properIntersection(a: Point, b: Point, c: Point, d: Point) {
  return cross(a,b,c) * cross(a,b,d) < -EPS && cross(c,d,a) * cross(c,d,b) < -EPS;
}
function validRing(ring: readonly Point[]) {
  return ring.length >= 3 && polygonArea(ring) > EPS && ring.every((a,i) => {
    const b = ring[(i+1)%ring.length]!;
    return Math.hypot(a.x-b.x,a.y-b.y) > EPS && ring.every((c,j) => i === j || (i+1)%ring.length === j || (j+1)%ring.length === i || !properIntersection(a,b,c,ring[(j+1)%ring.length]!));
  });
}
/** A wall may form the region's boundary, but may never cross its interior. */
export function zoneCrossesWall(zone: SpawnZone, a: Point, b: Point) {
  const rings = [zoneBoundary(zone), ...(zone.polygon?.holes ?? [])];
  const dx=b.x-a.x, dy=b.y-a.y;
  const cuts=[0,1];
  for (const ring of rings) for (let i=0;i<ring.length;i++) {
    const c=ring[i]!,d=ring[(i+1)%ring.length]!, ex=d.x-c.x,ey=d.y-c.y;
    const denom=dx*ey-dy*ex;
    if(Math.abs(denom)<EPS) continue;
    const t=((c.x-a.x)*ey-(c.y-a.y)*ex)/denom;
    const u=((c.x-a.x)*dy-(c.y-a.y)*dx)/denom;
    if(t>0&&t<1&&u>=-EPS&&u<=1+EPS) cuts.push(t);
  }
  cuts.sort((u,v)=>u-v);
  return cuts.slice(1).some((end,i)=>{
    const t=(cuts[i]!+end)/2,p={x:a.x+dx*t,y:a.y+dy*t};
    return zoneContainsPoint(zone,p) && rings.every(ring=>ring.every((c,j)=>segmentDistance(p,c,ring[(j+1)%ring.length]!)>EPS));
  });
}
export function spawnZonesOverlap(a: SpawnZone, b: SpawnZone) {
  if (a.x >= b.x+b.width || b.x >= a.x+a.width || a.y >= b.y+b.height || b.y >= a.y+a.height) return false;
  const aa=zoneBoundary(a),bb=zoneBoundary(b);
  return aa.some(p=>zoneContainsPoint(b,p)) || bb.some(p=>zoneContainsPoint(a,p)) || aa.some((p,i)=>bb.some((q,j)=>properIntersection(p,aa[(i+1)%aa.length]!,q,bb[(j+1)%bb.length]!))) || zoneContainsPoint(a,{x:b.x+b.width/2,y:b.y+b.height/2}) && zoneContainsPoint(b,{x:b.x+b.width/2,y:b.y+b.height/2});
}
export function spawnZoneError(building: BuildingScenario, zone: SpawnZone): string | null {
  const boundary=zoneBoundary(zone),holes=zone.polygon?.holes??[];
  if (![boundary,...holes].every(validRing)) return "Spawn polygons need a simple boundary with at least three points.";
  if ([boundary,...holes].some(r=>r.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<zone.x-EPS||p.x>zone.x+zone.width+EPS||p.y<zone.y-EPS||p.y>zone.y+zone.height+EPS))) return "Spawn polygon points must fit inside their bounds.";
  if (holes.some(h=>!h.every(p=>polygonContainsPoint(boundary,p)))) return "Spawn polygon holes must lie inside the boundary.";
  const area=polygonArea(boundary)-holes.reduce((sum,h)=>sum+polygonArea(h),0);
  if(zone.width<2*building.agent_radius||zone.height<2*building.agent_radius||zone.count*Math.PI*building.agent_radius**2>area) return "Spawn zones need enough area and width for the configured occupant discs.";
  if (building.walls.some(w=>zoneCrossesWall(zone,w.start,w.end))) return "Spawn zones cannot pass through walls. Fill each enclosed room separately.";
  return null;
}
/** Conservative packing capacity for room fill; objects remain visible above the zone. */
export function roomSpawnCapacity(building: BuildingScenario, zone: SpawnZone) {
  const radius=building.agent_radius, spacing=radius*4.5;
  let capacity=0;
  for(let y=zone.y+radius;y<=zone.y+zone.height-radius+EPS;y+=spacing) for(let x=zone.x+radius;x<=zone.x+zone.width-radius+EPS;x+=spacing) {
    const p={x,y};
    if (!zoneContainsDisc(zone,p,radius)) continue;
    if(building.walls.some(w=>segmentDistance(p,w.start,w.end)<radius+w.thickness/2)) continue;
    if(building.obstructions.some(o=>Math.hypot(x-Math.max(o.x,Math.min(o.x+o.width,x)),y-Math.max(o.y,Math.min(o.y+o.height,y)))<radius)) continue;
    if(building.spawn_zones.some(z=>z.id!==zone.id&&zoneContainsDisc(z,p,0))) continue;
    capacity++;
  }
  return capacity;
}
