# Why these defaults

Go Away's defaults follow published research where it exists, and say so when a choice is a product decision instead. The same content is returned by the MCP tool `explain_break_science` (source: `src/core/science.ts`).

| Setting | Default | Evidence |
| --- | --- | --- |
| Eye break | 20 s every 20 min | The 20-20-20 rule. In a 2023 trial, prompted breaks reduced digital eye strain and dry-eye symptoms; the benefit faded once prompting stopped [1][2]. |
| Long break | 5 min every 60 min | NIOSH field studies added four 5-min breaks per day (about one an hour) for data-entry workers: less discomfort and eye strain, no loss of productivity [3][4]. A meta-analysis found breaks of 10 min or less increase vigor and reduce fatigue; performance effects were small and task dependent [5]. |
| Long-break prompts suggest walking | — | Interrupting sitting every 20 min with 2 min of light walking lowered post-meal glucose and insulin [6]. |
| Never interrupt meetings/calls; hold long breaks to the end of a focus block | — | Interruptions mid-task raise stress and frustration [7]; deferring them to a natural breakpoint reduces frustration and resumption time [8]. |

Product choices (not research findings):

- Breaks can't be skipped once they start. The reminder studies only show benefits when the breaks are actually taken.
- 5+ idle minutes (not on a call) counts as a long break.
- A long break due just before a meeting is pulled forward so it ends right before the meeting.
- Settings that weaken breaks apply only after the next completed break.

## Sources

1. Talens-Estarelles C. et al. (2023). The effects of breaks on digital eye strain, dry eye and binocular vision: Testing the 20-20-20 rule. *Contact Lens and Anterior Eye*, 46(2), 101744. [Aston Research Explorer](https://research.aston.ac.uk/en/publications/the-effects-of-breaks-on-digital-eye-strain-dry-eye-and-binocular/)
2. American Academy of Ophthalmology. [Computers, Digital Devices and Eye Strain](https://www.aao.org/eye-health/tips-prevention/computer-usage)
3. Galinsky T.L. et al. (2000). A field study of supplementary rest breaks for data-entry operators. *Ergonomics*, 43(5), 622-638. [CDC Stacks](https://stacks.cdc.gov/view/cdc/198356)
4. Galinsky T. et al. (2007). Supplementary breaks and stretching exercises for data entry operators: a follow-up field study. *American Journal of Industrial Medicine*, 50(7), 519-527. [CDC Stacks](https://stacks.cdc.gov/view/cdc/186286)
5. Albulescu P. et al. (2022). "Give me a break!" A systematic review and meta-analysis on the efficacy of micro-breaks for increasing well-being and performance. *PLOS ONE*, 17(8), e0272460. [PMC9432722](https://pmc.ncbi.nlm.nih.gov/articles/PMC9432722/)
6. Dunstan D.W. et al. (2012). Breaking up prolonged sitting reduces postprandial glucose and insulin responses. *Diabetes Care*, 35(5), 976-983. [PMC3329818](https://pmc.ncbi.nlm.nih.gov/articles/PMC3329818/)
7. Mark G., Gudith D., Klocke U. (2008). The cost of interrupted work: more speed and stress. *CHI 2008*. [PDF](https://www.ics.uci.edu/~gmark/chi08-mark.pdf)
8. Iqbal S.T., Bailey B.P. (2008). Effects of intelligent notification management on users and their tasks. *CHI 2008*. [PDF](https://www.interruptions.net/literature/Iqbal-CHI08.pdf)
