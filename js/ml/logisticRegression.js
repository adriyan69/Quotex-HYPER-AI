/**
 * LogisticRegression — a small hand-written binary classifier, trained by
 * batch gradient descent with L2 regularization. No external ML library:
 * this app has been zero-dependency through 10 phases already, and
 * shipping a multi-megabyte tensor library for one experimental feature
 * would work against everything it's been (small, installable, works
 * offline, runs on a phone). Logistic regression on a ~15-feature vector
 * is plenty for what this phase asks for: an honesty check on whether a
 * learned probability estimate is well-calibrated out-of-sample, not a
 * production predictive system.
 */
export class LogisticRegression {
  constructor(options = {}) {
    this.epochs = options.epochs ?? 300;
    this.learningRate = options.learningRate ?? 0.2;
    this.l2 = options.l2 ?? 0.02;
    this.weights = null;
    this.bias = 0;
  }

  fit(X, y) {
    const n = X.length;
    const numFeatures = X[0].length;
    this.weights = new Array(numFeatures).fill(0);
    this.bias = 0;

    for (let epoch = 0; epoch < this.epochs; epoch++) {
      const gradW = new Array(numFeatures).fill(0);
      let gradB = 0;

      for (let i = 0; i < n; i++) {
        const pred = this.predictProba(X[i]);
        const error = pred - y[i];
        for (let j = 0; j < numFeatures; j++) gradW[j] += error * X[i][j];
        gradB += error;
      }

      for (let j = 0; j < numFeatures; j++) {
        this.weights[j] -= this.learningRate * (gradW[j] / n + this.l2 * this.weights[j]);
      }
      this.bias -= this.learningRate * (gradB / n);
    }

    return this;
  }

  predictProba(x) {
    let z = this.bias;
    for (let i = 0; i < x.length; i++) z += x[i] * this.weights[i];
    return sigmoid(z);
  }
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Z-score standardizes a training feature matrix (mean 0, stddev 1 per
 * column) and applies the SAME mean/stddev — fit on train only — to any
 * other feature sets passed in (validation/test). Fitting standardization
 * on anything but the training set would leak information from
 * validation/test into what the model effectively sees, so this always
 * derives mean/std from `rawTrainX` alone.
 *
 * @param {Array<Array<number>>} rawTrainX
 * @param {...Array<Array<number>>} rawOtherXSets
 * @returns {{ trainX: Array<Array<number>>, otherSets: Array<Array<Array<number>>> }}
 */
export function standardize(rawTrainX, ...rawOtherXSets) {
  const numFeatures = rawTrainX[0].length;
  const means = new Array(numFeatures).fill(0);
  const stds = new Array(numFeatures).fill(1);

  for (let j = 0; j < numFeatures; j++) {
    let sum = 0;
    for (const row of rawTrainX) sum += row[j];
    means[j] = sum / rawTrainX.length;
  }
  for (let j = 0; j < numFeatures; j++) {
    let sumSq = 0;
    for (const row of rawTrainX) sumSq += (row[j] - means[j]) ** 2;
    const variance = sumSq / rawTrainX.length;
    stds[j] = Math.sqrt(variance) || 1; // avoid divide-by-zero for a constant feature column
  }

  const apply = (rows) => rows.map((row) => row.map((v, j) => (v - means[j]) / stds[j]));

  return {
    trainX: apply(rawTrainX),
    otherSets: rawOtherXSets.map(apply),
  };
}
