"use client";
import { useId, useRef, useState } from "react";
import type { Xstock } from "../lib/xstocks";
import { XstockLogo } from "./xstock-logo";
export const XSTOCK_ROW_HEIGHT = 64;
export function visibleXstocks(length: number, scrollTop: number) {
  const start = Math.max(0, Math.floor(scrollTop / XSTOCK_ROW_HEIGHT) - 3);
  return { start, end: Math.min(length, start + 12) };
}
export function XstockPicker({
  rows,
  selected,
  onSelect,
  searching,
}: {
  rows: Xstock[];
  selected?: Xstock;
  onSelect: (mint: string) => void;
  searching: boolean;
}) {
  const [open, setOpen] = useState(searching),
    [scroll, setScroll] = useState(0),
    [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null),
    id = useId();
  const { start, end } = visibleXstocks(rows.length, scroll);
  function select(index: number) {
    if (rows[index]) {
      onSelect(rows[index].mint);
      setOpen(false);
      trigger.current?.focus();
    }
  }
  function move(index: number) {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setActive(next);
    setOpen(true);
    const position = Math.max(0, (next - 2) * XSTOCK_ROW_HEIGHT);
    setScroll(position);
    if (list.current) list.current.scrollTop = position;
  }
  return (
    <div
      className="xstock-picker"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <span className="fine">Official xStock ({rows.length} matches)</span>
      <button
        type="button"
        ref={trigger}
        className="xstock-selected"
        role="combobox"
        aria-label={`Official xStock (${rows.length} matches)`}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="listbox"
        aria-activedescendant={
          open && active >= start && active < end
            ? `${id}-${active}`
            : undefined
        }
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            move(active + (e.key === "ArrowDown" ? 1 : -1));
          } else if (e.key === "Home" || e.key === "End") {
            e.preventDefault();
            move(e.key === "Home" ? 0 : rows.length - 1);
          } else if (e.key === "Escape") setOpen(false);
          else if ((e.key === "Enter" || e.key === " ") && open) {
            e.preventDefault();
            select(active);
          }
        }}
      >
        {selected ? (
          <>
            <XstockLogo asset={selected} />
            <span>
              {selected.symbol} · {selected.name}
            </span>
          </>
        ) : (
          <span>Select an official asset to inspect</span>
        )}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          id={id}
          role="listbox"
          aria-label="Official xStock results"
          className="xstock-results"
          ref={(node) => {
            list.current = node;
            if (node && node.scrollTop !== scroll) node.scrollTop = scroll;
          }}
          onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        >
          {!rows.length && <p className="fine">No matching official assets.</p>}
          <div
            style={{
              height: rows.length * XSTOCK_ROW_HEIGHT,
              position: "relative",
            }}
          >
            {rows.slice(start, end).map((asset, i) => (
              <button
                key={asset.mint}
                id={`${id}-${start + i}`}
                type="button"
                role="option"
                aria-selected={selected?.mint === asset.mint}
                aria-posinset={start + i + 1}
                aria-setsize={rows.length}
                className="xstock-option"
                title={asset.mint}
                onClick={() => select(start + i)}
                style={{
                  position: "absolute",
                  top: (start + i) * XSTOCK_ROW_HEIGHT,
                  height: XSTOCK_ROW_HEIGHT,
                }}
              >
                <XstockLogo asset={asset} />
                <span>
                  <strong>
                    {asset.symbol} · {asset.name}
                  </strong>
                  <small>{asset.status}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
