Welcome to a new blog! In the great 2026!

This site will serve as a journal to record any of my whims, be it creative or computational. I plan to dabble in a lot of things, but as I do want this site to double as a portfolio, I would like to show off my computational skills as much as possible.

Posts are written in **Markdown**, and Python code blocks
become cells you can run right in the browser (powered by Pyodide).

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

(The inner workings behind this journal entry)

![image](/blog/images/2026-10-01-pasted-obbf.png)
