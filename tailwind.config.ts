import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

export default {
	darkMode: ["class"],
	content: [
		"./index.html",
		"./src/**/*.{ts,tsx}",
	],
	prefix: "",
	theme: {
		container: {
			center: true,
			padding: '2rem',
			screens: {
				'2xl': '1400px'
			}
		},
		extend: {
			fontFamily: {
				// Body: Inter, self-hosted through @fontsource. Display: Fraunces,
				// a soft serif for the farm name, panel titles and produce counts.
				sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
				display: ['"Fraunces Variable"', 'Fraunces', 'Georgia', 'serif'],
			},
			colors: {
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				primary: {
					DEFAULT: 'hsl(var(--primary))',
					foreground: 'hsl(var(--primary-foreground))'
				},
				secondary: {
					DEFAULT: 'hsl(var(--secondary))',
					foreground: 'hsl(var(--secondary-foreground))'
				},
				destructive: {
					DEFAULT: 'hsl(var(--destructive))',
					foreground: 'hsl(var(--destructive-foreground))'
				},
				muted: {
					DEFAULT: 'hsl(var(--muted))',
					foreground: 'hsl(var(--muted-foreground))'
				},
				accent: {
					DEFAULT: 'hsl(var(--accent))',
					foreground: 'hsl(var(--accent-foreground))'
				},
				popover: {
					DEFAULT: 'hsl(var(--popover))',
					foreground: 'hsl(var(--popover-foreground))'
				},
				card: {
					DEFAULT: 'hsl(var(--card))',
					foreground: 'hsl(var(--card-foreground))'
				},
				// Game-specific colours the shadcn set has no word for. See index.css.
				farm: {
					wood: 'hsl(var(--farm-wood))',
					'wood-dark': 'hsl(var(--farm-wood-dark))',
					harvest: 'hsl(var(--farm-harvest))',
					water: 'hsl(var(--farm-water))',
					rot: 'hsl(var(--farm-rot))',
					meadow: 'hsl(var(--farm-meadow))',
				}
			},
			borderRadius: {
				lg: 'var(--radius)',
				md: 'calc(var(--radius) - 2px)',
				sm: 'calc(var(--radius) - 4px)'
			},
			boxShadow: {
				// One soft drop plus one inner highlight: the paper panel treatment.
				panel: '0 1px 0 hsl(var(--farm-highlight)) inset, 0 8px 20px -12px hsl(var(--farm-shade))',
				pill: '0 1px 0 hsl(var(--farm-highlight)) inset, 0 2px 6px -3px hsl(var(--farm-shade))',
			},
			keyframes: {
				'accordion-down': {
					from: {
						height: '0'
					},
					to: {
						height: 'var(--radix-accordion-content-height)'
					}
				},
				'accordion-up': {
					from: {
						height: 'var(--radix-accordion-content-height)'
					},
					to: {
						height: '0'
					}
				}
			},
			animation: {
				'accordion-down': 'accordion-down 0.2s ease-out',
				'accordion-up': 'accordion-up 0.2s ease-out',
				'farm-rise': 'farm-rise 1.3s ease-out forwards',
				'farm-glow': 'farm-glow 1.8s ease-in-out infinite',
			}
		}
	},
	plugins: [tailwindcssAnimate],
} satisfies Config;
