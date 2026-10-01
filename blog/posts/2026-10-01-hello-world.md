Welcome to the blog! Posts are written in **Markdown**, and Python code blocks
become cells you can run right in the browser.

```python
import numpy as np
data = np.random.default_rng(0).normal(size=1000)
f"mean {data.mean():.3f}, std {data.std():.3f}"
```

Cells share variables, so later cells can use earlier results:

```python
import matplotlib.pyplot as plt
plt.hist(data, bins=30)
plt.title("1,000 samples from a normal distribution")
plt.show()
```

Code that shouldn't run can use a `python-static` block:

```python-static
# this is just displayed, not executed
```
