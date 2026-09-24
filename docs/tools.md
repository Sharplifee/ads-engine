# Which tool does which job
The engine is deliberately model- and vendor-agnostic. Each job names what it needs,
not who provides it, so any piece can be swapped without touching the rest.

| Job | Used for | Currently |
|---|---|---|
| Ad platform read/write | every account action | Meta official connector + Marketing API |
| Competitor scraping | public ad library | Apify actor |
| Site reading | brand intake, landing page checks | plain fetch, no vendor |
| Transcription | operator videos and podcasts | Scribbly |
| Reasoning — cheap, high volume | claim extraction, tagging, policy parsing | Sonnet |
| Reasoning — heavy | full strategy build, diagnosis | Opus |
| Weather and seasonality | demand timing | open-meteo, no key |
| Image generation | static ad assets | not connected yet |
| Video generation | motion ad assets | not connected yet |
| Search | market questions the sources miss | not connected yet |

Rule: a generated asset never misrepresents the product or the work. Anything
showing the actual service must be real footage.
