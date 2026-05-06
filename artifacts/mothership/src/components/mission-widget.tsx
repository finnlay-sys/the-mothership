import { Rnd, type RndDragCallback, type RndResizeCallback } from "react-rnd";
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";

export type WidgetBox = { x: number; y: number; w: number; h: number; z: number };

type MissionWidgetProps = {
  title: string;
  accentColor?: string;
  box: WidgetBox;
  minWidth?: number;
  minHeight?: number;
  bounds?: string | Element;
  onChange: (box: WidgetBox) => void;
  onFocus: () => void;
  headerExtra?: ReactNode;
  children: ReactNode;
  testId?: string;
};

export function MissionWidget({
  title,
  accentColor = "primary",
  box,
  minWidth = 320,
  minHeight = 200,
  bounds = "parent",
  onChange,
  onFocus,
  headerExtra,
  children,
  testId,
}: MissionWidgetProps) {
  const handleDragStop: RndDragCallback = (_e, d) => {
    onChange({ ...box, x: d.x, y: d.y });
  };

  const handleResizeStop: RndResizeCallback = (_e, _dir, ref, _delta, position) => {
    onChange({
      x: position.x,
      y: position.y,
      w: ref.offsetWidth,
      h: ref.offsetHeight,
      z: box.z,
    });
  };

  return (
    <Rnd
      size={{ width: box.w, height: box.h }}
      position={{ x: box.x, y: box.y }}
      onDragStop={handleDragStop}
      onResizeStop={handleResizeStop}
      onMouseDown={onFocus}
      onTouchStart={onFocus}
      bounds={bounds}
      minWidth={minWidth}
      minHeight={minHeight}
      dragHandleClassName="mission-widget-drag-handle"
      style={{ zIndex: box.z }}
      enableResizing={{
        top: false,
        right: false,
        bottom: false,
        left: false,
        topRight: false,
        bottomRight: true,
        bottomLeft: false,
        topLeft: false,
      }}
      className="!flex"
      data-testid={testId}
    >
      <div
        className={`flex flex-col w-full h-full bg-card border border-${accentColor}/40 rounded-sm overflow-hidden shadow-[0_0_24px_rgba(0,0,0,0.45)]`}
      >
        <div
          className={`mission-widget-drag-handle bg-secondary/60 border-b border-${accentColor}/30 px-3 py-2 flex items-center justify-between gap-2 cursor-move select-none shrink-0`}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <GripVertical className={`w-3.5 h-3.5 text-${accentColor} shrink-0`} />
            <span
              className={`font-mono text-[11px] font-bold text-${accentColor} tracking-widest uppercase truncate`}
            >
              {title}
            </span>
          </div>
          {headerExtra && (
            <div
              className="flex items-center gap-2 shrink-0"
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            >
              {headerExtra}
            </div>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-hidden relative">{children}</div>
      </div>
    </Rnd>
  );
}
