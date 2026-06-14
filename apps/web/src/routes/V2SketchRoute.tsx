import { Link, Navigate, useParams } from 'react-router-dom';
import {
  V2AuthCallbackSketch,
  V2ChatSketch,
  V2DevicesSketch,
  V2InviteSketch,
  V2LandingSketch,
  V2SecuritySketch,
  V2SettingsSketch,
  V2Sketchbook,
  V2StorageSketch,
  V2TransparencySketch,
} from '../v2/routes';
import { v2RouteSketches } from '../v2/mocks/sketch-data';

const sketchComponents = {
  landing: V2LandingSketch,
  chat: V2ChatSketch,
  settings: V2SettingsSketch,
  security: V2SecuritySketch,
  devices: V2DevicesSketch,
  storage: V2StorageSketch,
  invite: V2InviteSketch,
  callback: V2AuthCallbackSketch,
  transparency: V2TransparencySketch,
} as const;

type SketchId = keyof typeof sketchComponents;

function isSketchId(value: string | undefined): value is SketchId {
  return value !== undefined && value in sketchComponents;
}

function V2DevNav({ active }: { active?: string }) {
  return (
    <details className="fixed bottom-4 right-4 z-50 hidden md:block">
      <summary className="cursor-pointer list-none rounded-xl border border-white/[0.08] bg-[#151a20]/95 px-3 py-2 text-xs font-medium text-white/70 shadow-2xl shadow-black/35 backdrop-blur transition-colors hover:text-white">
        Sketches
      </summary>
      <div className="absolute bottom-12 right-0 flex w-56 flex-col gap-1 rounded-2xl border border-white/[0.08] bg-[#151a20]/95 p-1 shadow-2xl shadow-black/35 backdrop-blur">
        <Link
          to="/v2"
          className={`rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
            active === undefined ? 'bg-white/[0.08] text-white' : 'text-white/50 hover:text-white'
          }`}
        >
          Index
        </Link>
        {v2RouteSketches.map(({ id, label }) => {
          const isSelected = active === id;
          return (
            <Link
              key={id}
              to={`/v2/${id}`}
              className={`rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                isSelected ? 'bg-teal-300/12 text-teal-100' : 'text-white/50 hover:text-white'
              }`}
            >
              {label}
            </Link>
          );
        })}
      </div>
    </details>
  );
}

export default function V2SketchRoute() {
  const { sketchId } = useParams();

  if (sketchId === undefined) {
    return (
      <>
        <V2Sketchbook />
        <V2DevNav />
      </>
    );
  }

  if (!isSketchId(sketchId)) return <Navigate to="/v2" replace />;

  const Sketch = sketchComponents[sketchId];

  return (
    <>
      <Sketch />
      <V2DevNav active={sketchId} />
    </>
  );
}
