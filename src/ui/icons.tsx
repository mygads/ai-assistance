// Ikon SVG inline (T25 follow-up restyle): satu set ikon konsisten gaya Fluent,
// diwarisi warna teks via currentColor. aria-hidden: ikon murni dekoratif,
// nama aksesibel tombol tetap berasal dari teks label (diuji L2).
import type { JSX } from "react";

type IconProps = { size?: number };
function base(size: number, children: JSX.Element, viewBox = "0 0 16 16") {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, verticalAlign: "text-bottom" }}
    >
      {children}
    </svg>
  );
}

export const AppIcon = ({ size = 22 }: IconProps) =>
  base(size, (<>
    <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="currentColor" stroke="none" opacity="0.16" />
    <path d="M4.5 6.5v3M6.8 4.8v6.4M9.2 6.5v3M11.5 8v0" strokeWidth={1.8} />
    <circle cx="11.5" cy="8" r="0.4" fill="currentColor" />
  </>));

export const MicIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <rect x="6" y="1.5" width="4" height="7" rx="2" />
    <path d="M3.8 7.5a4.2 4.2 0 0 0 8.4 0M8 11.7v2.3M5.8 14h4.4" />
  </>));

export const LoopbackIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <path d="M2.5 6v3.5h3M2.8 6.2 5.5 4.5v5.2" />
    <path d="M6 4.5h5.2a2.3 2.3 0 0 1 0 4.6H8" />
    <path d="M8 12.5h3.2a2.3 2.3 0 0 0 0-4.6" opacity="0.55" />
  </>));

export const PlayIcon = ({ size = 16 }: IconProps) =>
  base(size, (<path d="M5 3.2v9.6L12.5 8 5 3.2Z" fill="currentColor" stroke="none" />));

export const PauseIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <rect x="4" y="3" width="2.6" height="10" rx="0.8" fill="currentColor" stroke="none" />
    <rect x="9.4" y="3" width="2.6" height="10" rx="0.8" fill="currentColor" stroke="none" />
  </>));

export const StopIcon = ({ size = 16 }: IconProps) =>
  base(size, (<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />));

export const SendIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <path d="M14 2 7.3 8.7M14 2 9.6 14l-2.3-5.3L2 6.4 14 2Z" />
  </>));

export const RefreshIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.8v2.7h-2.7" />
  </>));

export const ContinueIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <path d="M3 3.5v9l7-4.5-7-4.5Z" fill="currentColor" stroke="none" opacity="0.9" />
    <path d="M11 4.5v7" strokeWidth={1.8} />
    <path d="M13.2 4.5v7" strokeWidth={1.8} />
  </>));

export const ShortenIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <circle cx="4.5" cy="4.5" r="2" />
    <circle cx="4.5" cy="11.5" r="2" />
    <path d="M6.2 5.8 14 13M6.2 10.2 14 3" />
  </>));

export const CancelIcon = ({ size = 16 }: IconProps) =>
  base(size, (<path d="M4 4l8 8M12 4l-8 8" strokeWidth={1.8} />));

export const FollowIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M1.8 8S3.8 4.5 8 4.5 14.2 8 14.2 8 12.2 11.5 8 11.5 1.8 8 1.8 8Z" />
  </>));

export const BookIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <path d="M3 2.5h8.5A1.5 1.5 0 0 1 13 4v9.5H4.5A1.5 1.5 0 0 1 3 12V2.5Z" />
    <path d="M3 10.5h10M6 5h4" />
  </>));

export const DocIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <path d="M4 1.8h5.5L12.5 5v9.2H4V1.8Z" />
    <path d="M9.3 2v3.2h3.2M6 8h4M6 10.5h4" />
  </>));

export const GlobeIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M1.8 8h12.4M8 1.8c-3.6 3.4-3.6 9 0 12.4M8 1.8c3.6 3.4 3.6 9 0 12.4" />
  </>));

export const CpuIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
    <path d="M6.5 1.8v2M9.5 1.8v2M6.5 12.2v2M9.5 12.2v2M1.8 6.5h2M1.8 9.5h2M12.2 6.5h2M12.2 9.5h2" />
  </>));

export const SunIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3 3.4 12.6" />
  </>));

export const MoonIcon = ({ size = 16 }: IconProps) =>
  base(size, (<path d="M13.5 10.5A5.8 5.8 0 0 1 5.5 2.5a5.8 5.8 0 1 0 8 8Z" />));

export const MonitorIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <rect x="2" y="3" width="12" height="8" rx="1.2" />
    <path d="M6 13.5h4M8 11v2.5" />
  </>));

export const CheckIcon = ({ size = 16 }: IconProps) =>
  base(size, (<path d="M2.5 8.5 6.5 12.5 13.5 4" strokeWidth={1.8} />));

export const SparkleIcon = ({ size = 16 }: IconProps) =>
  base(size, (<>
    <path d="M8 1.8c.4 3.2 2 4.8 5.2 5.2-3.2.4-4.8 2-5.2 5.2-.4-3.2-2-4.8-5.2-5.2 3.2-.4 4.8-2 5.2-5.2Z" />
    <path d="M12.5 12.5c.2 1.3.8 1.9 2.1 2.1-1.3.2-1.9.8-2.1 2.1-.2-1.3-.8-1.9-2.1-2.1 1.3-.2 1.9-.8 2.1-2.1Z" opacity="0.6" />
  </>));
