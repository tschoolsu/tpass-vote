"use client";

import { Printer } from "lucide-react";
import { Button } from "tpass-ui";

export function PrintButton({ label = "列印" }: { label?: string }) {
  return (
    <Button type="button" variant="primary" onClick={() => window.print()}>
      <Printer className="h-4 w-4" /> {label}
    </Button>
  );
}
