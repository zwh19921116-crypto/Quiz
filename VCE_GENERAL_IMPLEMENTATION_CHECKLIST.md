# VCE General Mathematics Auto Create Checklist

Use this as a one-by-one implementation tracker for Maker Auto Create.

## Phase 0 - Setup And Safety

- [ ] Create a backup branch before major changes.
- [ ] Keep commits small: one feature block per commit.
- [ ] After each block, generate a sample quiz and manually verify at least 5 questions.

## Phase 1 - Unit Routing (Required First)

- [ ] Add separate pools in maker logic:
  - [ ] `generalUnit1Pool`
  - [ ] `generalUnit2Pool`
  - [ ] `generalUnit3Pool`
  - [ ] `generalUnit4Pool`
- [ ] Route grade values directly:
  - [ ] `vce-general-unit-1` -> Unit 1 pool
  - [ ] `vce-general-unit-2` -> Unit 2 pool
  - [ ] `vce-general-unit-3` -> Unit 3 pool
  - [ ] `vce-general-unit-4` -> Unit 4 pool
- [ ] Confirm each unit generates different topic mixes.

## Phase 2 - Subcategory Expansion

- [ ] Add missing subcategory options required by VCE General.
- [ ] Ensure each new subcategory appears in Auto Create UI dropdown.
- [ ] Ensure each new subcategory maps to a generator function.

## Phase 3 - Unit 1 Generators

- [ ] Fractions, decimals, percentages (full strand).
- [ ] Ratios and rates.
- [ ] Financial arithmetic basics.
- [ ] Indices and scientific notation.
- [ ] Algebraic manipulation basics.
- [ ] Perimeter, area, volume.
- [ ] Units and conversions.
- [ ] Pythagoras theorem.
- [ ] Basic trigonometry.
- [ ] Scale and similarity.
- [ ] Cartesian and linear graphing coverage.
- [ ] Data collection/displays, mean/median/mode, range/spread.
- [ ] Intro probability, Venn diagrams, two-way tables.

## Phase 4 - Unit 2 Generators

- [ ] Simple and compound interest.
- [ ] Loans and repayments.
- [ ] Depreciation.
- [ ] Investments and budgeting.
- [ ] Networks and paths.
- [ ] Minimum spanning tree.
- [ ] Shortest path.
- [ ] Critical path analysis.
- [ ] Scheduling problems.
- [ ] Matrix operations.
- [ ] Transition matrices.
- [ ] Scatterplots and correlation.
- [ ] Time series and trend lines.
- [ ] Conditional probability.
- [ ] Tree diagrams and probability rules.

## Phase 5 - Unit 3 Generators

- [ ] Types of data and collection methods.
- [ ] Data displays and comparison tasks.
- [ ] Measures of centre and spread.
- [ ] Standard deviation.
- [ ] Z-scores.
- [ ] Normal distribution tasks.
- [ ] Time series analysis and seasonal adjustment.
- [ ] Scatterplots, correlation, least squares regression line.
- [ ] Arithmetic sequences.
- [ ] Geometric sequences.
- [ ] Recurrence relations.
- [ ] Financial modelling set:
  - [ ] loans and investments
  - [ ] compound interest
  - [ ] reducing balance loans
  - [ ] annuities
  - [ ] depreciation

## Phase 6 - Unit 4 Generators

- [ ] Matrix notation.
- [ ] Matrix addition/subtraction.
- [ ] Matrix multiplication.
- [ ] Transition matrices.
- [ ] Network applications.
- [ ] Communication matrices.
- [ ] Dominance matrices.
- [ ] Practical matrix modelling.
- [ ] Graphs and networks.
- [ ] Eulerian trails.
- [ ] Hamiltonian paths.
- [ ] Minimum spanning trees.
- [ ] Shortest path algorithms.
- [ ] Critical path analysis.
- [ ] Project scheduling.
- [ ] Flow networks.

## Phase 7 - Pool Balancing And Coverage Rules

- [ ] Add unit-specific topic weighting (avoid over-repeating one topic).
- [ ] Ensure minimum topic coverage in each generated quiz.
- [ ] Ensure quiz contains mixed result types where appropriate.
- [ ] Prevent focused template mode from unintentionally collapsing topic variety.

## Phase 8 - Validation And Quality Gates

- [ ] Add per-topic validation checks for generated payloads.
- [ ] Add post-generation coverage report (included topics vs missing topics).
- [ ] Add duplicate-question guard.
- [ ] Add numeric sanity checks (division by zero, invalid matrix dimensions, invalid probabilities).

## Phase 9 - Testing Checklist

- [ ] Unit 1: generate 20 questions and verify expected Unit 1 topics appear.
- [ ] Unit 2: generate 20 questions and verify expected Unit 2 topics appear.
- [ ] Unit 3: generate 20 questions and verify expected Unit 3 topics appear.
- [ ] Unit 4: generate 20 questions and verify expected Unit 4 topics appear.
- [ ] Verify no repeated instruction blocks in solution UI.
- [ ] Verify generated answers match solutions for at least 10 random questions.

## Phase 10 - Release Steps

- [ ] Update maker version.
- [ ] Add brief changelog entry for VCE General Unit 1-4 support.
- [ ] Commit and push per phase.
- [ ] Keep rollback point tags after each major phase.
